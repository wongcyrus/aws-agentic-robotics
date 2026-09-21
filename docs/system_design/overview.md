# AWS Agentic Robotics & Multimodal System: Overall Architecture Specification (Overview)

![AWS Agentic Robotics Overall Architecture Topology (AWS Style)](./img/overall_architecture_topology_aws.png)

This document provides a birds-eye overview of the `amazon-agent-robotics` architecture, establishing a global perspective on technical structures and security models. This system seamlessly integrates Large Language Models (LLM), Amazon Nova smart robots, Xiaoice digital human presenters, secure remote SSM execution channels, and leverages the AWS Bedrock AgentCore Secure Gateway as its unified security boundary.

---

## 1. Architectural Vision & Core Scenarios

The system is designed to coordinate complex multi-modal interactions, remote telemetry, and secure command distribution for both physical devices and virtual characters:

1. **Autonomous Robot Control**:
   Allows end-users or LLM orchestrators to issue high-level text/voice commands (e.g., "wave", "go forward"). These instructions are translated into exact physical commands and published over AWS IoT Core MQTT topics to physical devices (humanoid robots, dogs, drones).
2. **Xiaoice Multimodal Digital Human Presenter**:
   A real-time audio-visual speaking portal. Input text is synthesized into high-quality speech via Amazon Polly, stored in an efficient caching table, and pushed with movement telemetry to drive digital human web views.
3. **Serverless Robot Simulator**:
   An interactive 3D virtual environment built side-by-side to verify physical robot motions and behavior trees in real-time without requiring physical hardware.
4. **Extreme Resource Efficiency**:
   By replacing the legacy, costly "One-Thing-One-Lambda" custom resource approach with a batching Custom Resource provider, the stack registers 100% of the devices using a single Lambda function, yielding a **92.3% reduction** in management overhead.

---

## 2. Overall Architecture Topology

The topology diagram above illustrates the network, compute, storage, and security layers of the entire stack. Colors match standard architectural guidelines:
* **Orange (Compute)**: AWS Lambda functions executing telemetry translation and tool logic.
* **Blue (Storage)**: DynamoDB Tables and S3 Buckets holding persistent states, assets, and speech caches.
* **Purple (Security)**: Cognito User/Identity Pools and IAM roles providing cryptographic verification.
* **Teal (Gateway)**: Unified API and device integration ingress boundaries (Bedrock Gateway, IoT Core).
* **Grey (Client)**: User control panels, simulators, and real-world edge controllers (Raspberry Pi).

---

## 3. Cross-Modal Data & Control Flows

### A. Autonomous Robot Action Flow
This flow governs direct real-time movement triggers from web applications to physical or simulated edge platforms:

1. **Authentication & Identity Exchange**: The operator logs in via Cognito User Pool on the Control Web App. The web app exchanges the token with the Cognito Identity Pool to receive short-lived AWS STS credentials.
2. **Command Dispatch**: The web app uses the temporary credentials to sign an HTTP request with AWS Signature Version 4 (SigV4) and invokes the **Bedrock AgentCore Secure Gateway**.
3. **Safe Target Routing**: The AgentCore Gateway inspects the SigV4 signature and securely routes the validated payload to the `RobotToolFunction` (Lambda).
4. **IoT Publishing**: The Lambda parses the payload, validates structural bounds, and publishes the execution schema to the strict device topic (e.g., `arn:aws:iot:*:*:topic/robot_*/topic`).
5. **Physical Execution**: The Raspberry Pi client on the robot, which maintains a persistent outbound MQTT connection, pulls the message and triggers physical servos, subsequently returning its telemetry back.

### B. Digital Human Multimodal Speech Flow
Designed to drive real-time voice, mouth movement, and expressions on the Xiaoice digital avatar:

1. **Speech Dispatch**: The control portal sends a text string to be synthesized.
2. **Gateway Authorization**: The request travels securely through the Bedrock Gateway to the `DigitalHumanToolFunction` (Lambda).
3. **Cache Lookup**: The Lambda inspects the DynamoDB `SpeechTable` partition key to see if this exact string has been synthesized before. If found, it skips synthesis to save costs.
4. **Polly Synthesis**: On a cache miss, the Lambda calls **Amazon Polly** (`polly:SynthesizeSpeech`) to generate raw audio, stores it in the `RobotImageBucket` (S3), and updates the metadata cache in the `SpeechTable`.
5. **Expression Driving**: The Lambda publishes an MQTT playback notification. The Web UI receives the message, streams the S3 audio, and synchronizes the avatar's lips via Web Audio RMS analysis.

---

## 4. Global Security Boundaries

The system is constructed with a "Zero-Trust" posture to protect edge physical machinery and cloud compute lanes:

* **IAM Least Privilege**:
  * Compute Lambdas are strictly restricted to precise device topics (e.g., `arn:aws:iot:*:*:topic/robot_*/topic` and `arn:aws:iot:*:*:topic/xiaoice_*/topic`) rather than wildcard (`*`) access.
  * The Batch IoT Provisioner is bounded strictly to the parameter prefix path (`arn:aws:ssm:*:*:parameter/iot/robotics/*`).
* **STS & SigV4 Signature Binding**:
  * Client-side applications never store hardcoded credentials. All AWS operations are performed using dynamic STS credentials valid for only 1 hour.
  * Every API interaction with the Bedrock Gateway is cryptographic, ensuring tamper-proof transmissions.
* **AWS Bedrock AgentCore Secure Gateway Shielding**:
  * Prevents direct internet exposure of Lambda endpoints.
  * Sandboxes the execution scopes between `robot-only-mcp-lambda` and `digital-human-mcp-lambda`, limiting the blast radius of any single component compromise.
