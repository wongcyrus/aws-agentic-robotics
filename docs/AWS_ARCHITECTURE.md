# AWS Cloud System Architecture & Design Specification

This document provides a unified, comprehensive overview of the AWS cloud architecture powering the **AWS Agentic Robotics** ecosystem. The platform combines real-time humanoid voice control, text-based robot control, MCP-driven device tooling, and the gesture-controlled **Domain Expansion AR Game** on a primarily serverless AWS foundation.

---

## 🏗️ Unified AWS System Design Diagram

The following layered diagram illustrates the complete end-to-edge cloud infrastructure, showing how browser clients, API gateways, serverless compute, AI models, storage systems, and IoT-connected devices interact across the platform:

```mermaid
graph TB
    subgraph ClientLayer ["Client Layer"]
        BrowserVoice["Voice Chat Client (v1.0.11)"]
        BrowserText["Text Control Web UI"]
        ExternalSDK["External SDK / XiaoIce Client"]
        BrowserGame["Domain Expansion Web (AR Game)"]
        ThreeJSSim["Humanoid Simulator (Three.js)"]
        PhysicalRobots["Physical Robots / Drones / Dogs"]
    end

    subgraph EdgeLayer ["Edge & Delivery Layer"]
        CFVoice["CloudFront CDN (Voice Web)"]
        CFGame["CloudFront CDN (Game Web)"]
        CFSim["CloudFront CDN (Simulator Web)"]
        S3Voice[("S3 Bucket: Voice Web")]
        S3Game[("S3 Bucket: Game Web")]
        S3Sim[("S3 Bucket: Simulator Web")]
    end

    subgraph SecurityLayer ["Security & Identity Layer"]
        CognitoPool["Cognito User Pool (User Directory)"]
        CognitoIdent["Cognito Identity Pool (IAM Credentials)"]
    end

    subgraph InterfaceLayer ["Interface & Routing Layer"]
        APIGatewayText["API Gateway REST API (Text Control)"]
        APIGatewayGame["API Gateway REST API (Game)"]
        APIGatewayWS["API Gateway WebSocket API (Game Signaling)"]
        BedrockAgentRuntime["Bedrock AgentCore Runtime (SigV4 WebSocket)"]
        BedrockMcpGateway["Bedrock AgentCore MCP Gateway (robot-only)"]
    end

    subgraph ComputeLayer ["Compute & Orchestration Layer"]
        FastAPIAgent["FastAPI Container (Voice Agent Runtime)"]
        LambdaText["Lambda Handler (Flask Text Control)"]
        LambdaMCP["Lambda Function URL (Shared Robotics MCP Server)"]
        LambdaRobotGateway["Lambda Target (Robot-only MCP Gateway)"]
        LambdaGame["Lambda Handler (Python Game Backend)"]
        SQSGame[("Amazon SQS (Image Fusion Queue)")]
        LambdaWorker["Lambda Worker (Bedrock Image Fusion)"]
    end

    subgraph AIModelLayer ["AI Model Layer"]
        NovaSonic["Amazon Nova 2 Sonic"]
        NovaText["Amazon Nova 2 Lite / Nova Pro"]
        NovaCanvas["Amazon Nova Canvas"]
    end

    subgraph DataLayer ["Data & State Layer"]
        DDBGame[("DynamoDB: Game & Snapshot Sessions")]
        DDBRobots[("DynamoDB: Robot Configuration & Joints")]
        DDBSpeech[("DynamoDB: Speech / Presenter Messages")]
        S3Audio[("S3 Bucket: Polly Audio Assets")]
    end

    subgraph DeviceLayer ["Device & Messaging Layer"]
        IoTCore["AWS IoT Core (MQTT Message Broker)"]
    end

    %% Edge delivery
    CFVoice --> S3Voice
    CFGame --> S3Game
    CFSim --> S3Sim
    BrowserVoice -->|Pulls Static Assets| CFVoice
    BrowserGame -->|Pulls Static Assets| CFGame
    ThreeJSSim -->|Pulls Static Assets| CFSim
    BrowserText -->|Loads Web App / API Calls| APIGatewayText
    ExternalSDK -->|Signed HTTP / SSE Calls| APIGatewayText

    %% Identity & auth
    BrowserVoice -->|Sign In| CognitoPool
    BrowserText -->|Sign In| CognitoPool
    BrowserGame -->|Sign In| CognitoPool
    BrowserVoice -->|Exchange Token| CognitoIdent
    CognitoIdent -->|Temporary IAM SigV4 Credentials| BrowserVoice

    %% Voice path
    BrowserVoice -->|SigV4 WebSocket Handshake| BedrockAgentRuntime
    BedrockAgentRuntime -->|Bidirectional Streaming| FastAPIAgent
    FastAPIAgent -->|Speech-to-Speech Inference| NovaSonic
    FastAPIAgent -->|SigV4 tools/list + tools/call| BedrockMcpGateway
    BedrockMcpGateway -->|Lambda Target Invocation| LambdaRobotGateway

    %% Text path
    APIGatewayText -->|Lambda Proxy| LambdaText
    LambdaText -->|Reasoning / Tool Selection| NovaText
    LambdaText -->|SigV4 JSON-RPC tools/list + tools/call| LambdaMCP
    LambdaText --> DDBRobots
    LambdaText --> DDBSpeech

    %% Game path
    BrowserGame -->|Public + Authenticated REST Calls| APIGatewayGame
    BrowserGame -->|Handshake with token secure| APIGatewayWS
    APIGatewayGame --> LambdaGame
    APIGatewayWS --> LambdaGame

    LambdaGame -->|Enqueue Image Requests| SQSGame
    SQSGame --> LambdaWorker
    LambdaWorker -->|Generate Image Fusion| NovaCanvas
    LambdaWorker -->|Update Snapshot Status| DDBGame
    LambdaGame --> DDBGame
    LambdaGame --> DDBRobots

    %% MCP execution path
    LambdaMCP -->|Robot / Dog / Drone / Speech Tools| IoTCore
    LambdaMCP --> DDBRobots
    LambdaMCP --> DDBSpeech
    LambdaMCP -->|Polly Audio Uploads| S3Audio

    %% Device sync
    IoTCore -->|MQTT Commands| PhysicalRobots
    IoTCore -->|MQTT Sync| ThreeJSSim
    FastAPIAgent --> DDBRobots
```

---

## 🎙️ Speech Control (Voice Web) Architectural Specifications

The Speech Control Cockpit is a high-performance, real-time voice streaming control interface powered by **Amazon Nova Sonic**.

### 1. Unified Authentication Protocol
* **The Flow**:
  1. The user logs in via a web interface (`/login.html`) against an **AWS Cognito User Pool**.
  2. The browser exchanges the Cognito Identity Token with an **AWS Cognito Identity Pool**.
  3. The Identity Pool vends short-lived, temporary AWS IAM credentials.
  4. The browser utilizes these credentials to cryptographically generate an **AWS Signature Version 4 (SigV4)** pre-signed handshake URL.
  5. The browser opens a secure WebSocket connection directly with the **AWS Bedrock AgentCore Runtime** boundary.
* **Security Benefit**: Zero AWS secrets are stored on the frontend, and no custom middleware server is needed to sign connections. Authentications are handled entirely at the AWS Cloud frontier.

### 2. Live2D Real-time Lip-Sync Processing Engine (`v1.0.11`)
The current browser lip-sync path combines real playback and microphone amplitude while staying compatible with Cubism 2 Live2D models:

1. **Assistant playback RMS**:
   Upon receiving raw WebSocket audio streaming chunks (`audioOutput` event), the client decodes the 16-bit PCM payload, computes RMS, and forwards it into `AudioPlayer`:
   $$\text{rms} = \sqrt{\frac{1}{N}\sum_{i=1}^N \text{pcm}[i]^2}$$
   The `AudioWorklet` remains the source of truth for active playback volume during speaker output.

2. **User microphone RMS**:
   During capture, `main.js` computes microphone RMS in the recording loop and pushes it into `audioPlayer.setInputVolume(rms)` for the right-side avatar.

3. **Cubism 2-safe mouth updates**:
   `live2d-avatar.js` applies the smoothed mouth-open value across multiple compatible parameter IDs, including:
   - `ParamMouthOpenY`
   - `PARAM_MOUTH_OPEN_Y`
   - `ParamMouthOpen`
   - `PARAM_MOUTH_OPEN`
   - `ParamA`

4. **Important debugging finding**:
   A lip-sync regression was caused by returning after the first attempted mouth parameter write. Some models only react when multiple IDs/API variants are tried, so the current code applies the value across all supported candidates each frame.

5. **Staging/browser cache finding**:
   Frontend version query strings on `main.js` and `live2d-avatar.js` matter. Without a cache bump, staging may continue serving an older broken module even after the source code is fixed.

---

## 💬 Text Control & Robot MCP Architectural Specifications

The Text Control service is the typed-command counterpart to the voice cockpit. It exposes a browser and SDK-friendly HTTP/SSE API, uses a Bedrock-hosted text model for reasoning, and delegates all physical device execution to a dedicated **robotics MCP server**.

### 1. Text Control Request Path
The deployed text surface is an **API Gateway REST API** backed by a **Flask application running on AWS Lambda**.

1. A browser client or external SDK calls `/api/chat`, `/api/talk`, `/api/xiaoice-chat-api-strands`, or `/api/xiaoice-chat-api-strands-stream`.
2. API Gateway forwards the request into the `text_control` Lambda runtime.
3. The Flask app applies the appropriate auth mode:
   * **Cognito/session-backed auth** for the interactive web UI routes.
   * **Signature-based XiaoIce protocol auth** (`X-Key`, `X-Sign`, `X-Timestamp`) for SDK-compatible chat endpoints.
4. The route layer enriches the request with robot context from **DynamoDB** and creates a per-session Strands agent.
5. The agent generates a response and, when action is required, calls one or more MCP tools to execute robot, dog, or drone operations.

### 2. Bedrock Text Model Layer
The text orchestration path uses a **Strands `BedrockModel`** as the reasoning engine for typed requests.

* **Current implementation default**: `us.amazon.nova-2-lite-v1:0`
* **Purpose**: Intent interpretation, multi-step tool selection, multilingual response generation, and session-aware follow-up handling.
* **Design note**: The text-control stack is model-pluggable. The surrounding Lambda + Strands + MCP architecture does not change if the deployment is upgraded to a larger **Amazon Nova 2 / Nova Pro-class** text model for deeper reasoning.

This means the system already separates:

| Surface | Model role | Current implementation |
| --- | --- | --- |
| Voice cockpit | Real-time speech-to-speech streaming | `amazon.nova-2-sonic-v1:0` |
| Text control | Text reasoning and tool orchestration | `us.amazon.nova-2-lite-v1:0` |
| AR image fusion | Image generation | `amazon.nova-canvas-v1:0` |

### 3. Robotics MCP Server as the Action Plane
The platform currently has two MCP execution surfaces:

1. A **shared MCP Lambda Function URL** used by text-control and broader tool domains.
2. A **robot-only AgentCore Gateway + Lambda target** used by the speech cockpit.

For the speech cockpit:

* The FastAPI AgentCore runtime calls the robot-only AgentCore Gateway with an **AWS SigV4-authenticated MCP client**.
* The gateway exposes tools using the required AgentCore name format:
  `{target_name}___{tool_name}`
* In this deployment, names look like:
  `robot-only-mcp-lambda___robot_wave`
* The speech runtime keeps these exact names end-to-end and does not rename them for the model.
* The robot-only Lambda strips the `robot-only-mcp-lambda___` prefix before dispatching to the internal robot action map.

For text control:

* The Text Control Lambda never publishes raw robot actions directly through ad hoc HTTP handlers when operating in agent mode.
* Instead, it uses an **AWS SigV4-authenticated MCP client** to:
  1. call `tools/list`,
  2. dynamically materialize MCP tools into Strands-compatible tool objects, and
  3. call `tools/call` for the selected device action.

The MCP server currently registers **92 tools** across these domains:

* **Robot tools**: humanoid locomotion, posture, combat, exercise, and pose actions
* **Dog tools**: quadruped movement, gestures, and advanced routines
* **Drone tools**: takeoff, landing, movement, and rotation controls
* **Dance tools**: choreography and showcase behaviors
* **Speech tools**: Amazon Polly-based text-to-speech broadcast to robots
* **Image/XiaoIce tools**: supporting media and external assistant workflows

### 4. Device Command Delivery
After a tool is selected, the MCP server becomes the operational control plane:

1. The MCP Lambda validates tool arguments and maps them to device executors.
2. Executors publish standardized commands to **AWS IoT Core MQTT topics** such as `robot_*/topic`, `dog_*/topic`, `drone_*/topic`, and `xiaoice_*/topic`.
3. Physical robots and the browser-based simulator consume the same command stream, which keeps digital twins and real hardware synchronized.
4. For speech playback, the MCP server synthesizes audio with **Amazon Polly**, uploads it to **Amazon S3**, creates a presigned URL, and publishes that URL through IoT for device playback.

### 5. AgentCore gateway debugging finding

During the robot-only speech migration, the most important operational finding was:

- **tool discovery success does not guarantee tool invocation success**

The decisive failure signal came from **BedrockAgentCoreGateway application logs**, which showed the Lambda target was being invoked but could not find the supported tool name in the invocation context. The current Lambda implementation now follows the documented AgentCore context contract and avoids broad fallback parsing.

### 6. Why This Split Architecture Matters
This Text Control + MCP decomposition cleanly separates concerns:

* **API Gateway + Flask Lambda** handles web/API protocol compatibility, auth, session management, and streaming responses.
* **Bedrock text models** decide intent and tool selection.
* **The MCP Lambda** owns the executable robotics tool catalog.
* **AWS IoT Core** remains the single transport layer to real devices and simulators.

This provides a stable contract for future expansion: new tools can be added inside the MCP server without redesigning the text UI, and the Bedrock model tier can be upgraded independently from the robot execution tier.

---

## 🎮 Domain Expansion Game Architectural Specifications

The JJK Domain Expansion AR Game incorporates high-fidelity hand sign gesture recognition using MediaPipe and interacts serverlessly with the AWS Cloud.

### 1. Secure Split-Routing REST Architecture
To deliver a secure game that perfectly integrates with native browser media elements (which cannot attach custom HTTP bearer authorization headers), we designed a **split-route API Gateway Rest API**:

* 🔒 **Cognito Protected Endpoints (Catch-All Proxy `/{proxy+}`)**:
  * Critical HTTP methods like `/api/enhance-portrait` (triggering expensive Bedrock Canvas style fusions), `/api/register-room`, `/api/live-status`, `/api/battle-result`, and `/api/trigger-technique` (orchestrating server-side JJK techniques) are proxy-mapped to the AWS Lambda backend.
  * **Server-Side Orchestration (`/api/trigger-technique`)**: Hand sign gestures and techniques are now sent directly to the serverless backend. The Lambda handler uses a server-defined mapping dictionary (`JJK_ACTION_MAP`) to translate JJK techniques to physical robot simulator actions, concurrently calling (1) the simulator REST endpoint and (2) the asynchronous MCP `robot_speak` tool for AWS Polly synthesized audio. This migrates high-fidelity cloud orchestration from client browser to backend server.
  * They are protected by an **API Gateway Cognito User Pools Authorizer**. If the client request lacks a valid Cognito bearer token, API Gateway drops the query instantly with a `401 Unauthorized` response.
* 🔓 **Public Media Access (`/api/get-snapshot` & `/api/last-image`)**:
  * Because standard browser HTML image elements (e.g., `<img src="...">`) fetch images natively and cannot append custom authorization headers, protecting image retrievals with Cognito would prevent pictures from loading.
  * We explicitly defined these two read-only endpoints as **explicit API Gateway resources** with `AuthorizationType.NONE`.
  * Because they are read-only and require a valid, secret `sessionId` (e.g., `"mcpserver"`) to locate the snapshot, they are completely safe from malicious exploits while allowing images to render flawlessly.

### 2. High-Performance Battle Mode Real-Time Sync
* **WebRTC P2P Signaling**: 
  The game supports local and online multiplayer modes. In online mode, browsers establish a secure, encrypted peer-to-peer **WebRTC** connection to stream user camera views directly between players' screens.
* **WebSocket Signaling**:
  The game's Socket.io / API Gateway WebSocket connection acts only as a lightweight room coordination signaling switchboard. It handles only game coordinates, technique triggers, and score broadcasts (never seeing camera streams), saving maximum cloud bandwidth and keeping latencies minimal.
  * **Cost-Saving Session Guards**: The frontend leverages a `setInterval` loop to verify the lifespan of the Cognito JWT token locally. Upon expiration, the frontend forces an immediate `.close()` event on the WebSocket, ensuring idle clients do not continuously drain API Gateway or AgentCore runtime billing meters.

### 3. Consolidated `"mcpserver"` Default Session Key
* **Standardization**: Both frontend elements ([battle.js](../domain-expansion-ar-game/static/js/battle.js), [hand_tracker.js](../domain-expansion-ar-game/static/js/hand_tracker.js)) and cloud backend components ([lambda_function.py](../domain-expansion-ar-game-serverless/backend/lambda_function.py), [image_processor.py](../domain-expansion-ar-game-serverless/backend/image_processor.py), [commentary.py](../domain-expansion-ar-game-serverless/backend/commentary.py)) default to a standard `"mcpserver"` session ID.
* This ensures that any battles fought, snapshots captured, or commentaries generated are seamlessly integrated and accessible by your conversational agents.
