# AWS Cost Estimation & Optimization Guide

This guide provides a comprehensive cost estimation for the AWS Agentic Robotics platform based on the latest official AWS pricing metrics. It covers the serverless application layers and the specialized **Amazon Bedrock AgentCore** container runtimes.

---

## 🏗️ Architecture Pricing Summary

Our system is divided into two distinct logical layers with completely different pricing models:
1. **Serverless Infrastructure Layer**: Billed purely on active demand, with generous free tiers.
2. **AI Container & Model Layer**: Powered by Amazon Bedrock AgentCore Runtime and Foundation Models.

### 📊 Metric Breakdown

| Layer | Service / Capability | Dimension | Unit Price | Expected Traffic (Dev/Test) | Est. Monthly Cost |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Serverless** | S3 & CloudFront | Website Storage & Transfer | $0.023/GB, first 1TB Out free | ~100MB static files, 1GB Out | **$0.00** |
| **Serverless** | API Gateway (REST & WS) | Connection minutes & messages | $0.25/M connection-min, $1.00/M msgs | ~500 connection-min, ~10k msgs | **$0.00** (Free Tier) |
| **Serverless** | AWS Lambda | Compute time & requests | $0.0000166667/GB-s, 1M requests free | ~50k invocations | **$0.00** (Free Tier) |
| **Serverless** | DynamoDB | Reads, Writes & Storage | On-Demand: $1.25/M writes, $0.25/M reads | ~50k reads/writes | **$0.00** (Free Tier) |
| **AI Containers** | **AgentCore Runtime (CPU)** | Active CPU consumption | **$0.0895 per vCPU-hour** | ~2 hours active CPU / month | **$0.18** |
| **AI Containers** | **AgentCore Runtime (Memory)** | Active Memory consumption | **$0.00945 per GB-hour** | ~5 hours active memory / month| **$0.05** |
| **AI Models** | **Bedrock Nova Pro (LLM)** | Input/Output Tokens & Images | Input: $0.0008/1k, Output: $0.0032/1k | ~1M tokens, 1k images | **$2.00** |

---

## ⚡ Under the Hood: How AgentCore Runtime Billing Works

A common misconception is that running custom containers in AWS incurs high 24/7 billing. However, **Amazon Bedrock AgentCore Runtime is built natively on a consumption-based serverless model**:

### 1. Idle State is $0.00 💤
If no players are connected and the voice/commentary agents are idle, you are billed **$0.00**. There are no continuous hourly provisioned instance fees.

### 2. "I/O Wait is Free" ⏸️
When an agent processes a request, the container spends the vast majority of its duration waiting for Bedrock Foundation Models (such as Nova Pro or Sonic) to generate tokens, or waiting on database writes and third-party API tools. 
- **AgentCore automatically suspends CPU compute billing during these I/O wait periods.**
- You are only billed for the millisecond increments where your container is actively running code.

### 3. Lightweight Health Checks 🔍
AWS performs periodic `/ping` health checks to ensure your containers are alive. Our FastAPI containers (`jjk_commentator_agentcore` and `robot_voice_agentcore`) are highly optimized and respond in under **1ms**. 
- Even with 43,200 pings a day: `43,200 * 0.001s = 43.2 seconds` of active CPU per day.
- Total cost: `43.2s * 1 vCPU * ($0.0895/3600) = $0.001/day` (approx. **$0.03/month**).

---

## 🧮 Real-World Session Cost Scenario

Let's calculate the exact cost of a single **JJK Match Commentary Round**:

1. A player triggers a gesture, sending a webcam frame.
2. The `jjk_commentator_agentcore` processes the frame, invokes Nova Pro, and streams the comment back via WebSocket.
3. Total duration of the session: **15 seconds**.
   - **Active CPU time**: 1 second (parsing JSON, signing handshakes).
   - **I/O Wait time** (waiting on Bedrock): 14 seconds (**Free**).
   - **Memory Allocated**: 1 GB for the full 15 seconds.

#### Cost Calculation:
* **Active CPU**: `1 second * 1 vCPU * ($0.0895 / 3,600)` = **`$0.0000248`**
* **Active Memory**: `15 seconds * 1 GB * ($0.00945 / 3,600)` = **`$0.0000393`**
* **Nova Pro Tokens**: ~1k input tokens, 1 image, 200 output tokens = **`$0.002640`**
* **Total Cost per Match Round**: **`$0.002704`** (About a quarter of a cent!)

> **To spend just $1.00 on the entire end-to-end compute layer, you can run more than 370 full-game matches!**

---

## 🛠️ Cost Optimization Best Practices

Keep your AWS bill at absolute zero during development with these simple tricks:

### 1. The Direct Bedrock Fallback (0% Container Cost)
Our backend Lambda contains a dual-engine architecture. By setting the environment variable in your Lambda or CDK configurations:
```bash
AGENT_TYPE="strands_local"
```
The Lambda will execute the agent orchestrations directly via the local **Strands SDK** inside the serverless Lambda function, bypassing the custom AgentCore containers entirely. This guarantees that container hosting metrics remain strictly at **$0.00**.

### 2. Teardown When Idle
When your testing phase is complete, you can destroy your active AWS resources instantly to prevent any accidental charges:
```bash
npx cdk destroy --all --force
```
You can rebuild and redeploy everything in under 3 minutes with:
```bash
./deploy.sh
```
