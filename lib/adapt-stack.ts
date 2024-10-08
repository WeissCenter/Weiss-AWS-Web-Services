import * as cdk from "aws-cdk-lib";
import * as path from "path";
import { Construct } from "constructs";
import { Effect, Policy, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { AdaptRestApi } from "../constructs/AdaptRestApi";
import { AdaptNodeLambda } from "../constructs/AdaptNodeLambda";
import { RequestAuthorizer } from "aws-cdk-lib/aws-apigateway";
import { Code } from "aws-cdk-lib/aws-lambda";
import { AdaptStackProps } from "./adpat-stack-props";
import { AdaptDynamoTable } from "../constructs/AdaptDynamoTable";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { AdaptS3Bucket } from "../constructs/AdaptS3Bucket";
import { Bucket, EventType, HttpMethods } from "aws-cdk-lib/aws-s3";
import { Database, Job } from "@aws-cdk/aws-glue-alpha";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";

interface AdaptApiStackProps extends AdaptStackProps {
  dynamoTables: { [key: string]: AdaptDynamoTable };
  cognito: {
    userPoolId: string;
    clientId: string;
  };
  stagingBucket: AdaptS3Bucket;
  repoBucket: AdaptS3Bucket;
  queryResultBucket: AdaptS3Bucket;
  dataCatalog: Database;
  crawlerRole: Role;
  glueJob: Job;
  suppressionServiceFunction: string;
  logGroup: LogGroup;
}

export class AdaptStack extends cdk.Stack {
  restApi: AdaptRestApi;

  constructor(scope: Construct, id: string, props: AdaptApiStackProps) {
    super(scope, id, props);

    const publicAssetsBucket = new AdaptS3Bucket(this, "PublicAssetsBucket", {
      bucketName: `${props.stage}-adaptpublicassetsbucket`,
      blockPublicAccess: {
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      },
      publicReadAccess: true,
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [HttpMethods.PUT],
          allowedOrigins: ["*"],
          exposedHeaders: [
            "x-amz-server-side-encryption",
            "x-amz-request-id",
            "x-amz-id-2",
          ],
          maxAge: 3000,
        },
      ],
    });

    const adaptAdminAuthorizerHandler = new AdaptNodeLambda(
      this,
      `AdaptAuthorizerHandler`,
      {
        prefix: props.stage,
        handler: "handler",
        entry: path.join(__dirname, ".", "./handlers/authorizer/authorizer.ts"),
        environment: {
          USER_POOL_ID: props.cognito.userPoolId,
          CLIENT_ID: props.cognito.clientId,
        },
        depsLockFilePath: path.join(
          __dirname,
          "handlers/authorizer/package-lock.json"
        ),
        attachPolicies: [
          new Policy(this, "CognitoPolicy", {
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                  "iam:ListRolePolicies",
                  "iam:GetRolePolicy",
                ],
                resources: ["*"], // TODO: restrict to the cognito user pool
              }),
            ],
          }),
        ],
      }
    );

    const adaptAdminAuthorizer = new RequestAuthorizer(
      this,
      "AdaptAdminAuthorizer",
      {
        handler: adaptAdminAuthorizerHandler,
        identitySources: ["method.request.header.Authorization"],
      }
    );

    const getDataSetHandler = new AdaptNodeLambda(this, "getDataSetHandler", {
      prefix: props.stage,
      handler: "handler",
      entry: path.join(__dirname, ".", "./handlers/getDataSet/getDataSet.ts"),
      attachPolicies: [
        new Policy(this, "getDataSet", {
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [props.dynamoTables["dataSourceTable"].tableArn],
            }),
          ],
        }),
      ],
      environment: {
        TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
      },
    });

    const getDataViewHandler = new AdaptNodeLambda(this, "getDataViewHandler", {
      prefix: props.stage,
      handler: "handler",
      entry: path.join(__dirname, ".", "./handlers/getDataView/getDataView.ts"),
      attachPolicies: [
        new Policy(this, "getDataView", {
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [props.dynamoTables["dataSourceTable"].tableArn],
            }),
          ],
        }),
      ],
      environment: {
        TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
      },
    });

    const getTemplateHandler = new AdaptNodeLambda(this, "getTemplateHandler", {
      prefix: props.stage,
      handler: "handler",
      entry: path.join(__dirname, ".", "./handlers/getTemplate/getTemplate.ts"),
      attachPolicies: [
        new Policy(this, "getTemplate", {
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [props.dynamoTables["templatesTable"].tableArn],
            }),
          ],
        }),
      ],
      environment: {
        TABLE_NAME: props.dynamoTables["templatesTable"].tableName,
      },
    });

    const createShareLinkHandler = new AdaptNodeLambda(
      this,
      "createShareLinkHandler",
      {
        prefix: props.stage,
        handler: "handler",
        entry: path.join(
          __dirname,
          ".",
          "./handlers/createShareLink/createShareLink.ts"
        ),
        attachPolicies: [
          new Policy(this, "createShareLink", {
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
                resources: [props.dynamoTables["shareTable"].tableArn],
              }),
            ],
          }),
        ],
        environment: {
          TABLE_NAME: props.dynamoTables["shareTable"].tableName,
        },
      }
    );

    const validateFileHandler = new AdaptNodeLambda(
      this,
      "validateFileHandler",
      {
        prefix: props.stage,
        handler: "handler",
        entry: path.join(
          __dirname,
          ".",
          "./handlers/validateFile/validateFile.ts"
        ),
        attachPolicies: [
          new Policy(this, "validateFile", {
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                resources: [props.dynamoTables["dataSourceTable"].tableArn],
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ["s3:GetObject"],
                resources: ["*"], // TODO: restrict to the staging bucket
              }),
            ],
          }),
        ],
        environment: {
          DATA_SOURCE_TABLE: props.dynamoTables["dataSourceTable"].tableName,
          TEMPLATE_TABLE: props.dynamoTables["templatesTable"].tableName,
          STAGING_BUCKET: props.stagingBucket.bucketName,
        },
        nodeModules: ["xlsx", "cheerio"],
      }
    );

    const existingStageBucket = Bucket.fromBucketAttributes(this, 'ImportedStageBucket', {
      bucketArn: props.stagingBucket.bucketArn,
      bucketName: props.stagingBucket.bucketName,
    });

    existingStageBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(validateFileHandler)
    );

    const restApi = new AdaptRestApi(this, `${props.stage}-AdaptApiStack`, {
      stage: props.stage,
      cognitoUserPool: {
        id: props.cognito.userPoolId,
        clientId: props.cognito.clientId,
      },
      authorizer: adaptAdminAuthorizer,
      apiName: "AdaptAdminApi",
      apiStageName: props.stage,
      endpoints: {
        "/data": {
          GET: new AdaptNodeLambda(this, "getDataSourcesHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/getDataSources/getDataSources.ts"
            ),
            attachPolicies: [
              new Policy(this, "getDataSources", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:Query"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
            },
          }),
          POST: new AdaptNodeLambda(this, "addNewDataSourceHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/addNewDataSource/addNewDataSource.ts"
            ),
            attachPolicies: [
              new Policy(this, "addNewDataSource", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:PutItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                      "secretsmanager:CreateSecret",
                      "secretsmanager:UpdateSecret",
                      "secretsmanager:GetSecretValue",
                    ],
                    resources: ["*"], // TODO: restrict to the secret
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                      "glue:CreateCrawler",
                      "glue:CreateConnection",
                      "glue:CreateDatabase",
                      "glue:CreateTable",
                      "glue:StartCrawler",
                    ],
                    resources: ["*"], // TODO: restrict to the glue database
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
              DATA_CATALOG: props.dataCatalog.catalogId,
              DATA_CATALOG_NAME: props.dataCatalog.databaseName,
              CRAWLER_ROLE: props.crawlerRole.roleName,
            },
          }),
        },
        "/data/{dataSourceId}": {
          GET: new AdaptNodeLambda(this, "getDataSourceHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/getDataSource/getDataSource.ts"
            ),
            attachPolicies: [
              new Policy(this, "getDataSource", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: ["*"], // TODO: restrict to the secret
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
            },
          }),
          PUT: new AdaptNodeLambda(this, "editDataSourceHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/editDataSource/editDataSource.ts"
            ),
            attachPolicies: [
              new Policy(this, "editDataSource", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                      "secretsmanager:CreateSecret",
                      "secretsmanager:UpdateSecret",
                      "secretsmanager:GetSecretValue",
                    ],
                    resources: ["*"], // TODO: restrict to the secret
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                      "glue:CreateCrawler",
                      "glue:CreateConnection",
                      "glue:CreateDatabase",
                      "glue:CreateTable",
                      "glue:StartCrawler",
                    ],
                    resources: ["*"], // TODO: restrict to the glue database
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
              DATA_CATALOG: props.dataCatalog.catalogId,
            },
          }),
          DELETE: new AdaptNodeLambda(this, "deleteDataSourceHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/deleteDataSource/deleteDataSource.ts"
            ),
            attachPolicies: [
              new Policy(this, "deleteDataSource", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:DeleteItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
            },
          }),
        },
        "/data/{dataSourceId}/query": {
          POST: new AdaptNodeLambda(this, "queryDataSourceHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/queryDataSource/queryDataSource.ts"
            ),
            attachPolicies: [
              new Policy(this, "queryDataSource", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["s3:GetObject"],
                    resources: ["*"], // TODO: restrict to the staging bucket
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: ["*"], // TODO: restrict to the secret
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              STAGING_BUCKET: props.stagingBucket.bucketName,
            },
          }),
        },
        "/dataset": {
          GET: getDataSetHandler,
          POST: new AdaptNodeLambda(this, "addNewDataSetHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/addNewDataSet/addNewDataSet.ts"
            ),
            attachPolicies: [
              new Policy(this, "addNewDataSet", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
            },
          }),
        },
        "/dataset/{dataSetID}": {
          GET: getDataSetHandler,
        },
        "/dataview": {
          GET: getDataViewHandler,
          POST: new AdaptNodeLambda(this, "addNewDataViewHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/addNewDataView/addNewDataView.ts"
            ),
            attachPolicies: [
              new Policy(this, "addNewDataView", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem"],
                    resources: [props.dynamoTables["templatesTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:UpdateItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
              TEMPLATES_TABLE: props.dynamoTables["templatesTable"].tableName,
            },
          }),
        },
        "/dataview/upload": {
          POST: new AdaptNodeLambda(this, "startUploadDataViewFileHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/startUploadDataViewFile/startUploadDataViewFile.ts"
            ),
            attachPolicies: [
              new Policy(this, "startUploadDataView", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["s3:PutObject"],
                    resources: ["*"], // TODO: restrict to the staging bucket
                  }),
                ],
              }),
            ],
            environment: {
              STAGING_BUCKET: props.stagingBucket.bucketName,
            },
          }),
        },
        "/dataview/{dataViewID}": {
          GET: getDataViewHandler,
          PUT: new AdaptNodeLambda(this, "editDataViewHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/editDataView/editDataView.ts"
            ),
            attachPolicies: [
              new Policy(this, "editDataView", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem"],
                    resources: [props.dynamoTables["templatesTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
              TEMPLATES_TABLE: props.dynamoTables["templatesTable"].tableName,
            },
          }),
          DELETE: new AdaptNodeLambda(this, "deleteDataViewHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/deleteDataView/deleteDataView.ts"
            ),
            attachPolicies: [
              new Policy(this, "deleteDataView", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:DeleteItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["s3:DeleteObject"],
                    resources: ["*"], // TODO: restrict to the staging and repo buckets
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
              STAGING_BUCKET: props.stagingBucket.bucketName,
              REPO_BUCKET: props.repoBucket.bucketName,
            },
          }),
        },
        "/dataview/{dataViewID}/data": {
          POST: new AdaptNodeLambda(this, "getDataFromDataViewHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/getDataFromDataView/getDataFromDataView.ts"
            ),
            attachPolicies: [
              new Policy(this, "getDataFromDataView", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["lambda:InvokeFunction"],
                    resources: ["*"], // TODO: restrict to suppression service
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["s3:*"], // TODO: limit actions
                    resources: [props.queryResultBucket.bucketArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["glue:GetDatabase", "glue:GetTable"],
                    resources: [props.dataCatalog.catalogArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["athena:*"], // TODO: limit actions
                    resources: ["*"], // TODO: restrict to the data catalog
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              SUPPRESSION_SERVICE_FUNCTION: props.suppressionServiceFunction,
              BUCKET: props.queryResultBucket.bucketName,
              CATALOG: props.dataCatalog.catalogId,
              ATHENA_QUERY_RATE: "1000",
            },
            nodeModules: ["kysely"],
          }),
        },
        "/dataview/{dataViewID}/pull": {
          POST: new AdaptNodeLambda(this, "doDataPullHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/doDataPull/doDataPull.ts"
            ),
            attachPolicies: [
              new Policy(this, "doDataPull", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["glue:StartJobRun"],
                    resources: ["*"], // TODO: restrict to the glue job
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
              GLUE_JOB: props.glueJob.jobName,
            },
          }),
        },
        "/dataview/{dataViewID}/preview": {
          GET: new AdaptNodeLambda(this, "previewDataHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/previewData/previewData.ts"
            ),
            attachPolicies: [
              new Policy(this, "previewData", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem"],
                    resources: [props.dynamoTables["dataSourceTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["s3:GetObject"],
                    resources: ["*"], // TODO: restrict to the staging bucket
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: ["*"], // TODO: restrict to the secret
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              STAGING_BUCKET: props.stagingBucket.bucketName,
            },
            nodeModules: ["kysely", "mssql", "xlsx"],
          }),
        },
        "/validate-file/{dataViewID}": {
          GET: validateFileHandler,
        },
        "/report": {
          GET: new AdaptNodeLambda(this, "getReportsHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/getReports/getReports.ts"
            ),
            attachPolicies: [
              new Policy(this, "getReports", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:Query"],
                    resources: [props.dynamoTables["reportTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              REPORT_TABLE: props.dynamoTables["reportTable"].tableName,
            },
          }),
          POST: new AdaptNodeLambda(this, "createReportHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/createReport/createReport.ts"
            ),
            attachPolicies: [
              new Policy(this, "createReport", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:PutItem"],
                    resources: [props.dynamoTables["reportTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              REPORT_TABLE: props.dynamoTables["reportTable"].tableName,
            },
          }),
        },
        "/report/{reportId}": {
          GET: new AdaptNodeLambda(this, "getReportHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/getReport/getReport.ts"
            ),
            attachPolicies: [
              new Policy(this, "getReport", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem"],
                    resources: [props.dynamoTables["reportTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              REPORT_TABLE: props.dynamoTables["reportTable"].tableName,
            },
          }),
          PUT: new AdaptNodeLambda(this, "editReportHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/editReport/editReport.ts"
            ),
            attachPolicies: [
              new Policy(this, "editReport", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                    resources: [props.dynamoTables["reportTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              REPORT_TABLE: props.dynamoTables["reportTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
            },
          }),
        },
        "/report/{reportId}/publish": {
          POST: new AdaptNodeLambda(this, "publishReportHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/publishReport/publishReport.ts"
            ),
            attachPolicies: [
              new Policy(this, "publishReport", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem"],
                    resources: [props.dynamoTables["reportTable"].tableArn],
                  }),
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["glue:StartJobRun"],
                    resources: ["*"], // TODO: restrict to the glue job
                  }),
                ],
              }),
            ],
            environment: {
              REPORT_TABLE: props.dynamoTables["reportTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
              GLUE_JOB: props.glueJob.jobName,
            },
          }),
        },
        "/report/{reportId}/unpublish": {
          POST: new AdaptNodeLambda(this, "unPublishReportHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/unPublishReport/unPublishReport.ts"
            ),
            attachPolicies: [
              new Policy(this, "unPublishReport", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: [
                      "dynamodb:GetItem",
                      "dynamodb:UpdateItem",
                      "dynamodb:DeleteItem",
                    ],
                    resources: [props.dynamoTables["reportTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              REPORT_TABLE: props.dynamoTables["reportTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
            },
          }),
        },
        "/settings": {
          GET: new AdaptNodeLambda(this, "getSettingsHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/getSettings/getSettings.ts"
            ),
            attachPolicies: [
              new Policy(this, "getSettings", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:GetItem"],
                    resources: [props.dynamoTables["settingsTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              SETTINGS_TABLE: props.dynamoTables["settingsTable"].tableName,
            },
          }),
          POST: new AdaptNodeLambda(this, "updateSettingsHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/updateSettings/updateSettings.ts"
            ),
            attachPolicies: [
              new Policy(this, "updateSettings", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:UpdateItem"],
                    resources: [props.dynamoTables["settingsTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              SETTINGS_TABLE: props.dynamoTables["settingsTable"].tableName,
            },
          }),
        },
        "/settings/logo": {
          POST: new AdaptNodeLambda(this, "startSettingsLogoUploadHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/startSettingsLogoUpload/startSettingsLogoUpload.ts"
            ),
            attachPolicies: [
              new Policy(this, "startSettingsLogoUpload", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["s3:PutObject"],
                    resources: [publicAssetsBucket.bucketArn],
                  }),
                ],
              }),
            ],
            environment: {
              LOGO_BUCKET: publicAssetsBucket.bucketName,
            },
          }),
        },
        "/template/{templateType}": {
          GET: getTemplateHandler,
        },
        "/template/{templateType}/{templateID}": {
          GET: getTemplateHandler,
        },
        "/unique": {
          POST: new AdaptNodeLambda(this, "isUniqueHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(__dirname, ".", "./handlers/isUnique/isUnique.ts"),
            attachPolicies: [
              new Policy(this, "isUnique", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:Query"],
                    resources: [
                      props.dynamoTables["dataSourceTable"].tableArn,
                      props.dynamoTables["templatesTable"].tableArn,
                    ],
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME: props.dynamoTables["dataSourceTable"].tableName,
              REPORT_TABLE_NAME: props.dynamoTables["reportTable"].tableName,
            },
          }),
        },
        "/event": {
          POST: new AdaptNodeLambda(this, "recordEventHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/recordEvent/recordEvent.ts"
            ),
            attachPolicies: [],
            environment: {
              LOG_GROUP: props.logGroup.logGroupName,
            },
          }),
        },
        "/notifications": {
          POST: new AdaptNodeLambda(this, "registerPushNotificationsHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/registerPushNotifications/registerPushNotifications.ts"
            ),
            attachPolicies: [
              new Policy(this, "registerPushNotifications", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:PutItem"],
                    resources: [
                      props.dynamoTables["pushNotificationsTable"].tableArn,
                    ],
                  }),
                ],
              }),
            ],
            environment: {
              TABLE_NAME:
                props.dynamoTables["pushNotificationsTable"].tableName,
            },
          }),
        },
        "/test": {
          POST: new AdaptNodeLambda(this, "testDBConnectionHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/testDBConnection/testDBConnection.ts"
            ),
            attachPolicies: [],
            environment: {},
          }),
        },
        "/share": {
          POST: createShareLinkHandler,
        },
        "/share/{slug}": {
          GET: createShareLinkHandler,
        },
        "/user": {
          GET: new AdaptNodeLambda(this, "getUserActivityHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/getUserActivity/getUserActivity.ts"
            ),
            attachPolicies: [
              new Policy(this, "getUserActivity", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:*"], // TODO: limit actions
                    resources: [props.dynamoTables["dataSourceTable"].tableArn, props.dynamoTables["reportTable"].tableArn, props.dynamoTables["userActivityTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              USER_TABLE: props.dynamoTables["userActivityTable"].tableName,
              REPORT_TABLE: props.dynamoTables["reportTable"].tableName,
              DATA_TABLE: props.dynamoTables["dataSourceTable"].tableName,
            },
          })
        },
        "/users": {
          GET: new AdaptNodeLambda(this, "getUsersHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/getUsers/getUsers.ts"
            ),
            attachPolicies: [
              new Policy(this, "getUsers", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["iam:ListUsers", "iam:AdminListGroupsForUserCommand"],
                    resources: ["*"], // TODO: restrict to the UserPoolId
                  }),
                ],
              }),
            ],
            environment: {
              USER_POOL_ID: props.cognito.userPoolId,
            },
          }),
        },
        "/timedout": {
          POST: new AdaptNodeLambda(this, "userTimeoutCacheHandler", {
            prefix: props.stage,
            handler: "handler",
            entry: path.join(
              __dirname,
              ".",
              "./handlers/userTimeoutCache/userTimeoutCache.ts"
            ),
            attachPolicies: [
              new Policy(this, "userTimeoutCache", {
                statements: [
                  new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ["dynamodb:UpdateItem"],
                    resources: [props.dynamoTables["userActivityTable"].tableArn],
                  }),
                ],
              }),
            ],
            environment: {
              USER_TABLE: props.dynamoTables["userActivityTable"].tableName,
              LOG_GROUP: props.logGroup.logGroupName,
            },
          }),
        }
      },
    });
    this.restApi = restApi;
  }
}
