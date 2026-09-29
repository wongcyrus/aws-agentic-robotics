#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import { AwsAgenticRoboticsStack } from '../lib/cdk-stack';

// Load .env file from the cdk folder manually
try {
  const envPath = path.join(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
          process.env[key] = val;
        }
      }
    });
    console.log('✅ Loaded environment variables from cdk/.env');
  }
} catch (err) {
  console.warn('⚠️ Failed to load cdk/.env:', err);
}

const app = new cdk.App();
new AwsAgenticRoboticsStack(app, 'AwsAgenticRobotics', {
  stackName: 'aws-agentic-robotics',
});

app.synth();