#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core'
import { TelecomHubStack } from '../lib/telecom-hub-stack'

const app = new cdk.App()
new TelecomHubStack(app, 'TelecomHubStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '781897846687',
    region:  process.env.CDK_DEFAULT_REGION  ?? 'us-east-1',
  },
})
