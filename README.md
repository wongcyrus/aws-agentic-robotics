# AWS Agentic Robotics

A comprehensive voice-controlled robotics platform powered by AWS IoT, AWS Bedrock, and Amazon Nova. This project enables natural language control of humanoid robots and digital-human presenters through voice and text interfaces, with real-time 3D visualization, simulation capabilities, and secure authentication.

## 📚 Documentation

See the consolidated documentation index in [docs/README.md](docs/README.md), review our [AWS Cloud System Architecture Specification](docs/AWS_ARCHITECTURE.md), or check out our [AWS Cost Estimation & Optimization Guide](docs/COST_ESTIMATION.md).

## 🎯 Project Overview

AWS Agentic Robotics is a multi-component system that combines:

- **Voice Control**: Real-time speech-to-speech interaction using Amazon Nova Sonic
- **Robot & Presenter Control**: Physical humanoid robots and Xiaoice digital humans via AWS IoT and AgentCore gateway tools
- **3D Simulation**: Browser-based 3D robot simulator with realistic animations
- **Text Interface**: Web-based text control for robot commands
- **MCP Integration**: Model Context Protocol support for extensibility
- **Authentication**: AWS Cognito-based user authentication for secure access

## 🏗️ Architecture

The system consists of several interconnected components:

### Core Components

1. **Speech Control** (`speech_control_agentcore/`)

   - Real-time, bidirectional voice-to-voice streaming with Amazon Nova Sonic
   - Serverless AWS Bedrock AgentCore WebSocket Runtime connection patterns
   - Serverless static browser frontend hosted on Amazon S3 behind a CloudFront CDN
   - Direct browser-based IAM SigV4 authenticated WebSocket handshake signatures
   - Real-time dynamic system prompt adaptation matching selected hardware devices
   - Fluid, zero-refresh reconnection state machine and microphonic resource cleanup

2. **Serverless Humanoid Robot Simulator** (`humanoid-robot-simulator-serverless/`)

   - 3D web interface with Three.js visualization
   - 6 humanoid robots with 38 realistic actions
   - Real-time WebSocket communication
   - Serverless AWS Lambda Python Router backend and S3 static website hosted via CloudFront CDN

3. **Text Control** (`text_control/`)

   - Web-based text interface for robot control
   - Python Flask application with AWS Bedrock integration
   - Database-backed robot context and speech message management
   - AWS Cognito authentication integration
   - Command optimization system for faster response

4. **Robot Client** (`robot_client/`)

   - Physical robot control software
   - AWS IoT MQTT communication
   - Support for humanoid robots and related physical client workflows
   - Python-based with action execution system

5. **MCP Server** (`mcp_server/`)

   - Model Context Protocol server implementation
   - Humanoid robot and digital-human tool execution
   - AWS Lambda-based deployment

6. **CDK Infrastructure** (`cdk/`)
   - AWS Cloud Development Kit deployment scripts
   - Complete AWS infrastructure provisioning
   - Auto-scaling and monitoring configuration

7. **Domain Expansion AR Game** (`domain-expansion-ar-game/`)
   - Standalone AR experience using MediaPipe hand tracking
   - JJK-themed gesture control for robots
   - No WebSocket required for standalone mode

### Tech Blog

[Voice-Controlled Humanoid Robots Using Amazon Nova Sonic and AWS IoT](https://community.aws/content/2vqYxQLMJ8dYsL9kJnfPj0wIps3/voice-controlled-humanoid-robots-using-amazon-nova-sonic-and-aws-iot)

## 🚀 Quick Start

### 🔄 Keeping the Code Up-to-Date (Git Submodules)

This repository uses **Git Submodules** (like `humanoid-robot-simulator` and `domain-expansion-ar-game`). By default, a standard `git pull` updates the parent repository's commit reference but **does not** automatically update the submodule folders themselves.

To ensure your local submodules are always kept up-to-date when you pull, we recommend configuring Git to recurse into submodules:

#### Recommended: Configure Git to automatically update submodules on pull
Run this command once in this repository:
```bash
git config submodule.recurse true
```
*(Optional: Use `git config --global submodule.recurse true` to enable this behavior globally across all your repositories.)*

#### Alternative: Pull with recurse flag
```bash
git pull --recurse-submodules
```

#### Alternative: Manually update submodules after pulling
```bash
git submodule update --init --recursive
```

---

### Prerequisites

- Node.js 24 LTS or newer (for CDK and local Node.js services)
- Python 3.12+ (for deterministic tests and shared development tooling)
- AWS CLI configured with appropriate permissions
- Docker (optional, for containerized deployment)

### Environment Setup

#### Update Node.js to version 24 LTS

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Close the terminal and reopen, then:

```bash
nvm install 24
nvm use 24
nvm alias default 24
```

#### Install and Update CDK

```bash
cd cdk
pip install --upgrade awscli
npm uninstall -g cdk
npm install -g cdk
npm i -g npm-check-updates && ncu -u && npm i
```

#### Configure AWS CLI

```bash
aws configure
```

- Default region name: `us-east-1`
- Default output format: `json`

## 🏗️ Infrastructure Deployment

### Deploy AWS Infrastructure

1. **CDK Bootstrap** (first time only):

```bash
cd cdk
cdk bootstrap
```

2. **Deploy Stacks**:
   Install jq, if you don't have it.

```bash
sudo apt update && sudo apt install -y jq
```

> [!IMPORTANT]
> **ARM64 Emulation inside GitHub Codespaces / AMD64 Environments**
> 
> The AWS Bedrock AgentCore containers are built for **ARM64** architecture (`Platform.LINUX_ARM64`). If you deploy from an **AMD64/x86_64** host (like standard GitHub Codespaces):
> 1. The `./deploy.sh` script is fully automated and will try to install native host emulation using:
>    ```bash
>    sudo apt-get update && sudo apt-get install -y qemu-user-static binfmt-support
>    ```
> 2. If native installation is not supported by your host OS, the script will automatically fallback to registering emulation via a privileged binfmt Docker container.
> 3. Ensure Docker is running in your development environment before executing the deployment script.

Deployment

```bash
./deploy.sh
```

This script will:

- Deploy the CDK stack
- Validate the generated `cdk/output.json` before using any deployment output
- Automatically sync IoT certificates from S3 to local robot_client/certificates/

Network post-deploy checks are opt-in, so the default deployment behavior remains
unchanged:

```bash
# Check the deployed website and API endpoints
./deploy.sh --check-health

# Also invoke the commentator AgentCore runtime with a small health prompt
./deploy.sh --check-health --check-agentcore --check-timeout 30
```

Each check is bounded by the configured timeout. The AgentCore check can incur a
small runtime/model charge and requires `bedrock-agentcore:InvokeAgentRuntime`.

3. **Destroy Stacks** (when needed):

```bash
cd cdk
npx cdk destroy AwsAgenticRobotics --require-approval never
```

`AwsAgenticRobotics` is the CDK app selector; CloudFormation displays the physical stack name `aws-agentic-robotics`.

### Local Development Setup

#### Load Environment Variables

From the repository root:

```bash
sudo apt update && sudo apt install -y jq
source ./load_cdkstack_env.sh
```

The loader validates that the file contains exactly one stack, required outputs
are present, and output names/values are safe to export. It does not evaluate
the output file as shell code. Override the file for automation with
`CDK_OUTPUT_FILE=/path/to/output.json source ./load_cdkstack_env.sh`.

#### Download AWS IoT Certificates

```bash
source load_cdkstack_env.sh
aws s3 sync s3://$RobotDataBucketName robot_client/certificates/
```

#### Create Test Users (for authentication)

You can easily register or create test users directly inside your AWS Cognito User Pool via the AWS CLI:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id $CognitoUserPoolId \
  --username testuser \
  --user-attributes Name=email,Value=testuser@example.com
```

## 🤖 Component Usage

## Testing and coverage

Install the pinned root development tools and run static checks:

```bash
uv sync --only-group dev
./scripts/lint.sh
```

The root `pyproject.toml` and `uv.lock` pin shared Ruff and mypy tooling. Runtime
dependencies remain in each deployable service's `requirements.txt` because the
Lambda and AgentCore packaging boundaries resolve independently.

Run every deterministic unit suite across the CDK application, backend services,
Node helpers, robot clients, and robot skills:

```bash
./scripts/test-all.sh
```

Run only the core backend suites with their enforced line and branch coverage:

```bash
./scripts/coverage.sh
```

The backend command covers the simulator backend, MCP server, and speech
AgentCore backend, and enforces an 80% combined branch-inclusive minimum. Set
`COVERAGE_MIN` to test a proposed higher threshold:

```bash
COVERAGE_MIN=85 ./scripts/coverage.sh
```

The full suite enforces component-specific floors: CDK 95%, Node helpers 90%,
robot clients and skills 85%, Domain Expansion backend 80%, commentator
AgentCore 85%, and text control 85%. One-off administrative scripts are excluded
from text-control application coverage; deployed runtime modules remain measured.

The refactored request paths keep AWS entry points thin:

- `text_control/services/chat_orchestration.py` owns typed chat streaming
  orchestration.
- `text_control/services/robot_api.py` owns robot action and speech request
  normalization.
- `domain-expansion-ar-game-serverless/backend/http_request.py` owns HTTP request
  parsing and prompt/technique decisions.
- `domain-expansion-ar-game-serverless/backend/websocket_handler.py` owns
  WebSocket routing behind injected table and API clients.

AWS clients and resources are created through entry-point factories or lazy
accessors so unit tests can use local fakes. Structured log summaries redact
credentials and request bodies, and metrics use CloudWatch Embedded Metric
Format without requiring a CloudWatch client during tests.

### 1. Speech Control Interface

The serverless Speech Control frontend is served globally via AWS CloudFront. To run components locally for development:

**Run the Backend Agent Service:**
```bash
cd speech_control_agentcore
pip install -r requirements.txt
python robot_voice_agent.py
```

**Serve the Frontend Website Static Assets:**
```bash
cd speech_control_agentcore/public
python -m http.server 3000
```
Access the static developer interface at `http://localhost:3000`!

Features:

- Real-time voice interaction with Amazon Nova Sonic
- Multi-robot selection and control
- WebSocket-based audio streaming
- MCP tool integration
- Secure authentication with session management

### 2. Humanoid Robot Simulator

The active simulator lives in `humanoid-robot-simulator-serverless/` and is deployed as a static frontend with a Lambda/WebSocket backend. After `./deploy.sh`, open the `humanoidRobotSimulatorServerlessUrl` stack output.

Features:

- 6 humanoid robots with realistic 3D models
- 38 different actions (dance, combat, exercise, movement)
- Real-time WebSocket updates
- Group control capabilities

### 3. Text Control Interface

Web-based text control:

```bash
cd text_control
pip install -r requirements.txt
python app.py
```

Features:

- Text-based robot commands with intelligent optimization
- AWS Bedrock integration for complex commands
- Cognito-backed web authentication and hybrid API auth
- Robot knowledge-base management backed by DynamoDB
- SpeechTable cleanup console for digital-human message operations
- 2-4 second performance improvement for simple commands
- **Multiple Xiaoice Project Webhooks**: Deterministic `generate_keys.py` tool for managing `XIAOICE_PROJECT_CREDENTIALS` via AWS Secrets Manager.

### 4. Domain Expansion AR Game

Interactive hand-gesture control system:

- **Live Demo**: [Play Now](https://wongcyrus.github.io/domain-expansion-ar-game/)
- **Setup**: Open `domain-expansion-ar-game/index.html` in a web browser.
- **Local Testing**: Run `python3 serve_https.py` in the directory for mobile testing.

Features:

- Real-time 21-point hand tracking via MediaPipe
- JJK-themed visual effects (Unlimited Void, Hollow Purple, etc.)
- Direct REST API communication with robots
- Interactive "Energy Ball" finger tracking

### 5. Physical Robot Deployment

For physical robot hardware:

1. **Generate deployment package**:

   ```bash
   ./create_deploy_package.sh
   ```

2. **Transfer to robot** and extract:

   ```bash
   unzip deploy_package.zip
   ```

3. **Configure robot settings**:
   Edit `settings.yaml` to specify `robot_name` (robot_1 through robot_9 supported)

4. **Setup and run**:
   ```bash
   ./create_virtual_env.sh
   source venv/bin/activate
   python pubsub.py
   ```

## 🔧 Configuration

### Robot Configuration

The default cloud stack supports:

- **Humanoid Robots**: `robot_1` through `robot_6`
- **Digital Human**: `xiaoice_1`
- **Group Control**: Use `"all"` where supported by the tool schema

### MCP Integration

The serverless Bedrock AgentCore architecture uses an IAM-protected gateway for tool routing:
- **Robot-only target**: humanoid movement, stance, speech, and image tools
- **Digital-human target**: presenter speech tools isolated from physical robot tools
- **CDK-managed schemas**: tool schemas and gateway targets are declared in `cdk/lib/construct/robot-tool-gateway.ts`

The gateway uses AWS IAM authentication for secure tool invocation.

## 📊 Monitoring and Management

### API Endpoints

- **Speech Control**: `/api/mcp/status`, `/api/tools`, `/api/auth/config`, `/api/auth/login`
- **Robot Simulator**: WebSocket API for real-time control
- **Text Control**: RESTful API for command execution, robot CRUD, and SpeechTable cleanup
- **Authentication**: AWS Cognito integration for secure access

### Session Management

Each component supports session-based interaction with authentication:

- Speech sessions with automatic cleanup and Cognito authentication
- Simulator sessions with multi-user support and secure session keys
- Text sessions with Cognito-backed web access and hybrid API authentication

## 🔒 Security

- AWS IAM roles and policies for least-privilege access
- IoT device certificates for secure communication
- AWS Cognito authentication for web interfaces
- Session-based authentication with JWT tokens
- Socket.IO authentication middleware
- CORS configuration for web interfaces
- AgentCore gateway AWS IAM / SigV4 authentication support

## 🧩 Component Details

### Speech Control

- **Technology**: TypeScript, Node.js, Express, Socket.IO
- **Features**: Real-time audio streaming, MCP integration, multi-robot control, authentication
- **AI Model**: Amazon Nova Sonic for speech-to-speech processing
- **Authentication**: AWS Cognito with JWT tokens
- **MCP Support**: AWS SigV4 authentication for the AgentCore gateway
- **Deployment**: AWS Bedrock AgentCore runtime with a static frontend on S3/CloudFront

### Humanoid Robot Simulator

- **Technology**: Python Flask, Three.js, WebSocket
- **Features**: 6 robots, 38 actions, 3D visualization, session management
- **Actions**: Dance (10 styles), Combat, Exercise, Movement
- **Deployment**: Static frontend plus Lambda/WebSocket backend deployed by CDK

### Text Control

- **Technology**: Python Flask, AWS Bedrock
- **Features**: Text-based commands, robot context management, SpeechTable cleanup UI, and command optimization
- **Performance**: 2-4 second speedup for simple commands, 5x faster multi-robot execution
- **Commands**: 43+ robot commands automatically extracted from MCP server
- **Deployment**: AWS Lambda with API Gateway

### Domain Expansion AR Game

- **Technology**: Vanilla JavaScript, MediaPipe, Canvas API
- **Features**: Real-time hand tracking, cinematic JJK VFX, bilingual UI (EN/ZH)
- **Controls**: 8+ Domain Expansions and 3+ hand techniques
- **Deployment**: Standalone static site, GitHub Pages ready

### Robot Client

- **Technology**: Python, AWS IoT SDK, MQTT
- **Features**: Physical robot control, action execution, certificate-based auth
- **Hardware**: Humanoid robots

### MCP Server

- **Technology**: Python, AWS Lambda
- **Features**: AgentCore-compatible humanoid and digital-human tools with isolated gateway targets
- **Integration**: Extensible tool schema published through the gateway

### Infrastructure (CDK)

- **Services**: Bedrock AgentCore, Lambda, API Gateway, IoT Core, DynamoDB, S3, CloudFront, Cognito
- **Features**: Auto-scaling, monitoring, secure networking, batch IoT processing
- **Efficiency**: 92.3% reduction in Lambda functions through batch IoT device creation
- **Devices**: Default stack provisions 6 humanoid robots plus 1 xiaoice digital human
- **Region**: Primary deployment in us-east-1

## 🎮 Available Actions

### Humanoid Robot Actions (38 total)

#### Dance Actions (10 styles, 52-85 seconds each)

- `dance_one` through `dance_ten`
- Professional choreographed sequences
- Music-synchronized movements

#### Combat Actions

- `kung_fu`, `wing_chun`, `left_kick`, `right_kick`, `left_uppercut`, `right_uppercut`
- `left_shot_fast`, `right_shot_fast`
- Martial arts sequences with proper stances

#### Exercise Actions

- `push_ups`, `sit_ups`, `squat`, `squat_up`, `weightlifting`, `chest`
- Realistic exercise movements with proper form

#### Movement Actions

- `go_forward`, `back_fast`, `turn_left`, `turn_right`
- `left_move_fast`, `right_move_fast`, `stepping`
- Basic movement with directional control

#### Basic Actions

- `wave`, `bow`, `twist`, `stand`, `stand_up_back`, `stand_up_front`
- Basic interaction and positioning actions

## 🔗 Integration Points

### AWS Services

- **Bedrock**: AI model inference and streaming with Amazon Nova Sonic
- **IoT Core**: Device communication and management for humanoid robots and digital humans
- **Lambda**: Serverless compute for MCP and text control
- **DynamoDB**: Session and robot state storage
- **S3**: Certificate and asset storage
- **Cognito**: User authentication and session management

### Communication Protocols

- **WebSocket**: Real-time bidirectional communication
- **MQTT**: IoT device messaging
- **HTTP**: RESTful APIs and web interfaces
- **MCP**: Model Context Protocol for tool extensibility

## 🎯 Use Cases

1. **Educational Robotics**: Teaching programming and AI concepts
2. **Research Platform**: Testing voice-controlled robotics algorithms
3. **Entertainment**: Interactive robot demonstrations and performances
4. **Simulation**: Safe testing environment before physical deployment
5. **Development**: Rapid prototyping of robot behaviors and interactions

## 🐛 Troubleshooting

### Common Issues

1. **Session Connection Issues**

   - Verify WebSocket connectivity
   - Check session key validity
   - Ensure proper CORS configuration

2. **Robot Communication Problems**

   - Validate AWS IoT certificates
   - Check MQTT topic permissions
   - Verify robot naming convention

3. **MCP Tool Issues**
   - Check MCP server configuration
   - Verify tool auto-approval settings
   - Review server logs for connection errors

## 📈 Performance Considerations

- **Concurrent Sessions**: Supports multiple simultaneous voice sessions with authentication
- **Robot Capacity**: Default stack supports 6 humanoid robots plus 1 digital human presenter
- **Infrastructure Efficiency**: 92.3% reduction in Lambda functions through batch IoT processing
- **Auto-scaling**: Managed scaling for the serverless runtime and gateway-backed components
- **Session Cleanup**: Automatic cleanup of inactive sessions (5-minute timeout)
- **Command Optimization**: Text control bypasses LLM for simple commands (2-4s speedup)
- **Simulator Capacity**: 6 humanoid robots in 3D visualization with 38 available actions

## 🛠️ Development

### Local Development

Each component can be developed independently with hot reload support.

### Testing

- Unit tests for core functionality
- Integration tests for WebSocket communication
- End-to-end tests for robot action execution

### Deployment Options

- **Local**: Direct execution on development machine
- **Docker**: Containerized deployment with docker-compose
- **AWS**: Full cloud deployment with CDK
- **Hybrid**: Cloud services with local robot clients

## 📋 TODO

1. Fine-grained AWS IoT device permissions
2. Enhanced robot action choreography
3. Multi-language support for voice commands
4. Robot fleet management interface
5. Mobile application development
6. Real-time performance analytics dashboard
7. Advanced MCP tool marketplace integration
8. Enhanced video streaming with computer vision
9. Multi-user collaboration features
10. Robot behavior learning and adaptation
