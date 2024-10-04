// @ts-nocheck // FIXME: come back and fix typescript errors

import { Context, EventBridgeEvent, Handler } from "aws-lambda";
import {
  aws_generateDailyLogStreamID,
  aws_LogEvent,
  DataSetQueueStatus,
  EventType,
  getDataView,
  getSubscription,
  updateDataSetLastPullDate,
  updateDataSetQueueStatus,
} from "../../../libs/types/src";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
import { GetJobRunCommand, GlueClient } from "@aws-sdk/client-glue";
import * as webpush from 'web-push';

// Define Environment Variables
const TABLE_NAME = process.env["TABLE_NAME"] || "";
const NOTIFICATION_TABLE_NAME = process.env["NOTIFICATION_TABLE_NAME"] || "";
const LOG_GROUP = process.env["LOG_GROUP"] || "";
const PUBLIC_VAPID_KEY = process.env['PUBLIC_VAPID_KEY'] || "";
const PRIVATE_VAPID_KEY = process.env['PRIVATE_VAPID_KEY'] || "";

// AWS SDK Clients
const glueClient = new GlueClient({ region: "us-east-1" });
const client = new DynamoDBClient({ region: "us-east-1" });
const db = DynamoDBDocument.from(client);
const cloudwatch = new CloudWatchLogsClient({ region: "us-east-1" });

webpush.setVapidDetails(
  "https://weissta.org/",
  PUBLIC_VAPID_KEY,
  PRIVATE_VAPID_KEY
);

export const handler: Handler = async (
  event: EventBridgeEvent<string, any>,
  context: Context
) => {
  console.log(event);
  const logStream = aws_generateDailyLogStreamID();

  try {
    const detail = event.detail;

    const getRunCommand = new GetJobRunCommand({
      JobName: detail["jobName"],
      RunId: detail.jobRunId,
    });

    const result = await glueClient.send(getRunCommand);

    console.log("RESULT: ", result);

    const args = result?.JobRun?.Arguments;
    const state = result?.JobRun.JobRunState;

    const user = args?.["--user"];
    const dataView = args?.["--data-view-id"];

    const dynamoDataView = await getDataView(
      db,
      TABLE_NAME,
      dataView
    );

    switch (state) {
      case "SUCCEEDED": {
        await aws_LogEvent(
          cloudwatch,
          LOG_GROUP,
          logStream,
          user,
          EventType.SUCCESS,
          `Data Pull for ${dataView} succeeded`
        );

        await updateDataSetQueueStatus(
          db,
          TABLE_NAME,
          dataView,
          DataSetQueueStatus.AVAILABLE
        );
        await updateDataSetLastPullDate(
          db,
          TABLE_NAME,
          dataView,
          user
        );
        await sendPushMessage(
          `Data Pull for Data View ${dynamoDataView.name} succeeded`,
          user,
          db
        );
        break;
      }
      case "FAILED":
      case "ERROR": {
        await aws_LogEvent(
          cloudwatch,
          LOG_GROUP,
          logStream,
          user,
          EventType.ERROR,
          `Data Pull for ${dataView} failed`
        );

        await updateDataSetQueueStatus(
          db,
          TABLE_NAME,
          dataView,
          DataSetQueueStatus.FAILED
        );
        await sendPushMessage(
          `Data Pull for Data View ${dynamoDataView.name} failed`,
          user,
          db,
          false
        );
        break;
      }
      // case 'STOPPED':{
      //     await aws_LogEvent(cloudwatch, LOG_GROUP, logStream, user, EventType.ERROR, `Data Pull for ${dataSet} stopped`);

      //     await updateDataSetQueueStatus(db, TABLE_NAME, dataSet, DataSetQueueStatus.STOPPED);
      //     await sendPushMessage(`Data Pull for Data Set ${dynamoDataSet.name} was stopped`, user, db, false)
      //     break;
      // }
    }
  } catch (err) {
    console.error(err);
  }
};

async function sendPushMessage(
  message: string,
  id: string,
  db: DynamoDBDocument,
  success = true
) {
  const sub = await getSubscription(
    db,
    NOTIFICATION_TABLE_NAME,
    id
  );

  console.log("SUBSCRIPTION: ", sub);

  if (sub?.Item) {
    await webpush.sendNotification(
      sub?.Item.subscription,
      JSON.stringify({ success, message })
    );
    // notify the user
  }
}
