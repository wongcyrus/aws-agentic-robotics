/**
 * Enhanced 3D Humanoid Robot Simulator - 34 Actions Available
 * Complete action library with proper timing and realistic animations
 */

class HumanoidSimulator {
    constructor() {
        this.socket = null;
        this.scene3d = null;
        this.robots = new Map();
        this.isConnected = false;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.sessionKey = null;
        this.apiUrlPrefix = '';

        /** @type {boolean} Whether to append timestamp to video URLs to bypass cache */
        this.forceVideoReload = false;
        /** @type {string} Persistent random key for controlled cache busting */
        this.videoCacheKey = localStorage.getItem('video_cache_key') || 'v1';

        // Action queue system for sequential processing
        this.actionQueue = [];
        this.isProcessingQueue = false;

        // Resize debouncing
        this.resizeTimeout = null;

        // Action duration mapping (synchronized with animation system for precise timing)
        this.actionDurations = {
            // Dance actions (long durations) - Complex choreographed sequences
            'dance_two': 52,    // Energetic multi-phase dance with 5 distinct sections
            'dance_three': 70,  // Extended dance sequence with sophisticated timing
            'dance_four': 59,   // Moderate dance sequence with varied intensity
            'dance_five': 59,   // Moderate dance sequence with rhythmic patterns
            'dance_six': 69,    // Extended dance sequence with build-up and climax
            'dance_seven': 67,  // Extended dance sequence with complex choreography
            'dance_eight': 85,  // Long dance sequence with maximum complexity
            'dance_nine': 84,   // Long dance sequence with sustained high energy
            'dance_ten': 85,    // Long dance sequence with elaborate finale

            // Movement actions - Quick responsive locomotion
            'stepping': 3,       // Stepping in place with rhythm
            'twist': 4,          // Body twisting motion with momentum
            'stand_up_back': 5,  // Recovery from back position with support
            'stand_up_front': 5, // Recovery from front position with push-up
            'right_kick': 2,     // Quick right leg strike
            'left_kick': 2,      // Quick left leg strike
            'right_uppercut': 2, // Sharp right arm uppercut
            'left_uppercut': 2,  // Sharp left arm uppercut
            'wing_chun': 2,      // Wing chun martial arts technique
            'right_shot_fast': 4, // Quick right punch combination
            'left_shot_fast': 4,  // Quick left punch combination
            'chest': 9,          // Chest exercise routine with multiple reps
            'squat_up': 6,       // Squatting exercise with controlled movement
            'squat': 1,          // Quick single squat movement
            'bow': 4,            // Formal bowing gesture with proper timing
            'wave': 3.5,         // Friendly waving gesture with natural rhythm
            'turn_right': 4,     // 90-degree right turn with smooth acceleration
            'turn_left': 4,      // 90-degree left turn with smooth acceleration
            'sit_ups': 12,       // Extended sit-up routine (longest exercise)
            'right_move_fast': 3, // Quick right sidestep movement
            'left_move_fast': 3,  // Quick left sidestep movement
            'back_fast': 4.5,     // Quick backward movement with safety
            'go_forward': 3.5,    // Forward walking motion with natural gait
            'push_ups': 9,        // Push-up routine with proper form
            'weightlifting': 9,   // Weightlifting routine with controlled reps
            'kung_fu': 2,         // Kung fu strike with precision

            // Additional backend actions - System control
            'stand': 1,          // Return to neutral standing position
            'stop': 3,           // Stop all movement and return to rest

            // Default duration for unlisted actions
            'default': 2         // Standard fallback timing
        };

        console.log('🚀 Starting Enhanced Humanoid Simulator...');
        this.init();
    }

    init() {
        console.log('🔧 Initializing simulator components...');

        // Get session key from URL or prompt user
        this.sessionKey = this.getSessionKey();
        if (!this.sessionKey) {
            console.error('❌ No session key provided');
            return;
        }

        // Set the session key in UI
        const keyValElem = document.getElementById('session-key-val');
        if (keyValElem) {
            keyValElem.textContent = this.sessionKey;
        }

        console.log(`🔐 Using session key: ${this.sessionKey}`);

        // Initialize 3D scene first
        this.init3DScene();

        // Load robots from server
        this.loadRobotsFromServer();

        // Initialize WebSocket connection
        this.initWebSocket();

        // Setup UI event listeners
        this.setupUIEvents();

        // Initialize button states - stop button should be disabled initially
        this.disableStopButton();

        // Start periodic canvas size checking
        this.startCanvasSizeMonitoring();

        // Hide loading screen
        setTimeout(() => {
            const loadingScreen = document.getElementById('loading-screen');
            if (loadingScreen) {
                loadingScreen.classList.add('hidden');
            }
        }, 2000);

        console.log('✅ Simulator initialization complete');
    }

    getSessionKey() {
        // Try to get session key from URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        let sessionKey = urlParams.get('session_key');

        if (sessionKey) {
            // Normalize: handle URL encoding and common copy-paste space/+ issues
            // This MUST match the backend normalization in validation.py
            return decodeURIComponent(sessionKey).trim().replace(/ /g, "+");
        }

        // If no session key in URL, show error
        console.error('❌ No session key found in URL');
        document.body.innerHTML = `
            <div style="padding: 20px; text-align: center;">
                <h1>🔐 Session Key Required</h1>
                <p>Please provide a session key to access the robot simulator.</p>
                <p>Add <code>?session_key=YOUR_SESSION_ID</code> to the URL.</p>
                <p>Example: <code>${window.location.origin}${window.location.pathname}?session_key=my_session</code></p>
                <form onsubmit="window.location.href='/?session_key=' + document.getElementById('session_input').value; return false;">
                    <label>Session Key: </label>
                    <input type="text" id="session_input" placeholder="Enter your session ID" required>
                    <button type="submit">Connect</button>
                </form>
            </div>
        `;
        return null;
    }

    init3DScene() {
        console.log('🎬 Initializing 3D scene...');
        const canvas = document.getElementById('three-canvas');

        if (!canvas) {
            console.error('❌ Canvas element not found!');
            return;
        }

        this.scene3d = new Scene3D(canvas);

        // Initial canvas resize to ensure proper dimensions
        setTimeout(() => {
            this.resizeCanvas();
        }, 100);

        console.log('✅ 3D scene initialized');
    }

    async loadRobotsFromServer() {
        console.log('📡 Loading robots from server...');

        try {
            const response = await fetch(`${this.apiUrlPrefix}/api/robots?session_key=${this.sessionKey}`);
            const data = await response.json();

            if (data.success && data.robots) {
                console.log(`📡 Loaded ${data.robot_count} robots from server`);

                // Add robots to 3D scene
                Object.values(data.robots).forEach(robotData => {
                    if (this.scene3d) {
                        this.scene3d.addRobot(robotData);
                        this.robots.set(robotData.robot_id, robotData);
                    }
                });

                this.updateRobotCount();
                console.log('✅ Robots loaded from server successfully');
            } else {
                console.log('⚠️ No robots found on server, adding test robots as fallback');
                this.addTestRobots();
            }
        } catch (error) {
            console.error('❌ Failed to load robots from server:', error);
            console.log('⚠️ Using test robots as fallback');
            this.addTestRobots();
        }
    }

    addTestRobots() {
        console.log('🧪 Adding test robots as fallback...');

        const testRobots = [
            { robot_id: 'robot_1', position: [-50, 0, -50], color: '#4A90E2' },
            { robot_id: 'robot_2', position: [0, 0, -50], color: '#E24A90' },
            { robot_id: 'robot_3', position: [50, 0, -50], color: '#90E24A' },
            { robot_id: 'robot_4', position: [-50, 0, 50], color: '#E2904A' },
            { robot_id: 'robot_5', position: [0, 0, 50], color: '#904AE2' },
            { robot_id: 'robot_6', position: [50, 0, 50], color: '#4AE290' }
        ];

        testRobots.forEach(robotData => {
            if (this.scene3d) {
                const robot = this.scene3d.addRobot({
                    ...robotData,
                    rotation: [0, 0, 0],
                    current_action: 'stand',
                    action_progress: 0.0,
                    body_parts: {
                        head: { x: 0, y: 0, z: 0 },
                        torso: { x: 0, y: 0, z: 0 },
                        left_arm: { x: 0, y: 0, z: 0 },
                        right_arm: { x: 0, y: 0, z: 0 },
                        left_leg: { x: 0, y: 0, z: 0 },
                        right_leg: { x: 0, y: 0, z: 0 }
                    }
                });
                this.robots.set(robotData.robot_id, robotData);
            }
        });

        this.updateRobotCount();
        console.log('✅ Test robots added successfully');
    }

    async initWebSocket() {
        console.log('🔌 Initializing native WebSocket connection...');

        try {
            // Support local testing API prefixes and WebSocket overrides
            const urlParams = new URLSearchParams(window.location.search);
            this.apiUrlPrefix = urlParams.get('api_url') || '';
            
            let wsUrl = '';
            if (urlParams.has('ws_url')) {
                wsUrl = urlParams.get('ws_url');
            } else {
                // Try to load serverless config.json
                try {
                    const response = await fetch('/config.json');
                    if (response.ok) {
                        const config = await response.json();
                        if (config.webSocketUrl) {
                            wsUrl = `${config.webSocketUrl}?session_key=${this.sessionKey}`;
                            console.log(`📡 Loaded serverless WebSocket URL from config.json: ${wsUrl}`);
                        }
                    }
                } catch (configErr) {
                    console.warn('Could not load serverless config.json, falling back to relative routing:', configErr);
                }

                if (!wsUrl) {
                    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                    wsUrl = `${protocol}//${window.location.host}/ws?session_key=${this.sessionKey}`;
                }
            }

            console.log(`🔗 Connecting to: ${wsUrl}`);
            this.socket = new WebSocket(wsUrl);

            this.socket.onopen = () => {
                console.log('✅ Connected to WebSocket server');
                this.isConnected = true;
                this.retryCount = 0;
                this.updateConnectionStatus(true);

                // Join session explicitly on connection (APIGW WebSocket $default routing)
                console.log(`📡 Joining session: ${this.sessionKey}`);
                this.socket.send(JSON.stringify({
                    action: 'join_session',
                    session_key: this.sessionKey
                }));
            };

            this.socket.onclose = () => {
                console.log('🔌 Disconnected from WebSocket server');
                this.isConnected = false;
                this.updateConnectionStatus(false);
                this.attemptReconnect();
            };

            this.socket.onerror = (error) => {
                console.error('❌ WebSocket error:', error);
                this.updateConnectionStatus(false);
            };

            this.socket.onmessage = (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    const eventType = payload.type;
                    const data = payload.data;

                    switch (eventType) {
                        case 'robot_states':
                            console.log('📡 Real robot states received:', Object.keys(data).length, 'robots');
                            this.updateRobotStates(data);
                            break;

                        case 'action_result':
                            console.log('📨 Action result:', data);
                            this.handleActionResult(data);
                            break;

                        case 'robot_added':
                            console.log('➕ Robot added by server:', data);
                            if (this.scene3d && data.robot_data) {
                                this.scene3d.addRobot(data.robot_data);
                                this.robots.set(data.robot_id, data.robot_data);
                            }
                            this.updateRobotCount();
                            break;

                        case 'robot_removed':
                            console.log('🗑️ Robot removed by server:', data);
                            if (this.scene3d && data.removed_robot) {
                                this.scene3d.removeRobot(data.removed_robot);
                                this.robots.delete(data.removed_robot);
                            }
                            this.updateRobotCount();
                            break;

                        case 'robots_removed_all':
                            console.log('🗑️ All robots removed by server:', data);
                            if (this.scene3d && data.removed_robots) {
                                data.removed_robots.forEach(robotId => {
                                    this.scene3d.removeRobot(robotId);
                                    this.robots.delete(robotId);
                                });
                            }
                            this.updateRobotCount();
                            break;

                        case 'robots_reset':
                            console.log('🔄 Robots reset by server:', data);
                            this.robots.clear();
                            if (this.scene3d) {
                                this.scene3d.clearAllRobots();
                            }
                            if (data.robots) {
                                Object.values(data.robots).forEach(robotData => {
                                    if (this.scene3d) {
                                        this.scene3d.addRobot(robotData);
                                        this.robots.set(robotData.robot_id, robotData);
                                    }
                                });
                            }
                            this.updateRobotCount();
                            break;

                        case 'reset_result':
                            console.log('🔄 Reset session result:', data);
                            this.handleResetResult(data);
                            break;

                        case 'actions':
                            console.log('🎬 Server requested action execution:', data);
                            this.handleServerActionRequest(data);
                            break;

                        case 'speech':
                            console.log('🔊 Speech audio received:', data);
                            this.handleSpeechAudio(data);
                            break;

                        case 'video_source_changed':
                            console.log('📺 Video source change requested:', data);
                            this.handleVideoSourceChange(data);
                            break;

                        case 'video_control':
                            console.log('📺 Video control requested:', data);
                            this.handleVideoControl(data);
                            break;

                        case 'camera_control':
                            console.log('📷 Camera control received:', data);
                            if (data && data.type !== undefined) {
                                this.handleCameraControl(data);
                            } else if (this.scene3d) {
                                if (data.target_rotation_y !== undefined) {
                                    this.scene3d.targetRotationY = data.target_rotation_y;
                                }
                                if (data.target_rotation_x !== undefined) {
                                    this.scene3d.targetRotationX = data.target_rotation_x;
                                }
                                if (data.target_zoom !== undefined) {
                                    this.scene3d.targetZoom = data.target_zoom;
                                }
                            }
                            break;

                        case 'error':
                            console.error('❌ Server error:', data.message);
                            if (data.message && data.message.includes('Session key')) {
                                alert(`Session Error: ${data.message}`);
                            }
                            break;
                    }
                } catch (e) {
                    console.error('❌ Failed to parse WebSocket message:', e, event.data);
                }
            };

        } catch (error) {
            console.error('❌ WebSocket initialization failed:', error);
            this.updateConnectionStatus(false);
        }
    }

    attemptReconnect() {
        if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            console.log(`🔄 Attempting reconnection ${this.retryCount}/${this.maxRetries}...`);

            setTimeout(() => {
                if (!this.isConnected) {
                    this.initWebSocket();
                }
            }, 2000 * this.retryCount);
        } else {
            console.log('⚠️ Max reconnection attempts reached. Using test robots only.');
        }
    }

    updateRobotStates(robotStates) {
        console.log('🔄 Updating robot states...');

        if (!this.scene3d) {
            console.error('❌ Scene3D not available');
            return;
        }

        try {
            Object.entries(robotStates).forEach(([robotId, robotData]) => {
                console.log(`🤖 Processing ${robotId}:`, robotData);

                // Update or add robot
                if (this.robots.has(robotId)) {
                    this.scene3d.updateRobot(robotData);
                } else {
                    this.scene3d.addRobot(robotData);
                    this.robots.set(robotId, robotData);
                }
            });

            this.updateRobotCount();
            console.log('✅ Robot states updated successfully');

        } catch (error) {
            console.error('❌ Error updating robot states:', error);
        }
    }

    setupUIEvents() {
        console.log('🎮 Setting up UI events...');

        // Reset camera button
        const resetCameraBtn = document.getElementById('reset-camera');
        if (resetCameraBtn) {
            resetCameraBtn.addEventListener('click', () => {
                if (this.scene3d) {
                    this.scene3d.resetCamera();
                }
            });
        }

        // Reset button (combines reset session + force refresh)
        const resetBtn = document.getElementById('reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.resetSession();
            });
        }

        // Panel toggle button
        const togglePanelBtn = document.getElementById('toggle-panel');
        if (togglePanelBtn) {
            togglePanelBtn.addEventListener('click', () => {
                this.toggleControlPanel();
            });
        }

        // Action buttons - Send all actions through backend API
        const actionButtons = document.querySelectorAll('.action-btn');
        actionButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                const action = e.target.dataset.action;
                if (!action) return;

                const robotSelect = document.getElementById('robot-select');
                const robotId = robotSelect ? robotSelect.value : 'all';

                console.log(`🎬 Button clicked: ${action} for ${robotId}`);

                // Visual feedback - highlight button
                e.target.style.background = e.target.classList.contains('movement-btn') ? '#1e7e34' : '#2E6DA4';
                setTimeout(() => {
                    e.target.style.background = e.target.classList.contains('movement-btn') ? '#28a745' : '#4A90E2';
                }, 200);

                // Send action to backend - this will trigger proper events for proxy
                this.sendAction(robotId, action);

                // Update last action display
                this.updateLastAction(robotId, action);
            });
        });

        // Robot selection change
        const robotSelect = document.getElementById('robot-select');
        if (robotSelect) {
            robotSelect.addEventListener('change', (e) => {
                console.log('🎯 Selected robot:', e.target.value);
            });
        }

        // Window resize event listener with debouncing
        window.addEventListener('resize', () => {
            if (this.resizeTimeout) {
                clearTimeout(this.resizeTimeout);
            }
            this.resizeTimeout = setTimeout(() => {
                console.log('🖼️ Window resized, updating canvas dimensions');
                this.resizeCanvas();
            }, 150); // Debounce resize events
        });

        // Handle orientation change on mobile devices
        window.addEventListener('orientationchange', () => {
            setTimeout(() => {
                console.log('📱 Orientation changed, updating canvas dimensions');
                this.resizeCanvas();
            }, 500); // Delay for orientation change to complete
        });

        console.log('✅ UI events setup complete');
    }

    // Trigger action locally for immediate feedback
    triggerLocalAction(robotId, action, motions = {}, actionIds = {}) {
        console.log(`🎭 Triggering LOCAL action: ${action} for ${robotId}`);

        if (!this.scene3d) {
            console.warn('⚠️ Scene3D not available for local action');
            return;
        }

        if (robotId === 'all') {
            // Trigger action on all robots
            this.scene3d.triggerAllRobotsAction(action, motions, actionIds);
        } else {
            // Trigger action on specific robot
            this.scene3d.triggerRobotAction(
                robotId,
                action,
                motions[robotId] || null,
                actionIds[robotId] ?? null
            );
        }
    }

    sendActionByName(actionName, robotId = 'all') {
        console.log(`📡 Sending action by name: ${actionName} to ${robotId} in session: ${this.sessionKey}`);

        // Special handling for stop action - it should interrupt any running action
        if (actionName === 'stop') {
            if (this.isActionInProgress) {
                console.log(`🛑 Stop action interrupting current action: ${this.currentActionName}`);
                this.showNotification(`Stopping current action: ${this.currentActionName}`, 'info');
                // Stop current action and clear queue
                this.stopCurrentAction();
            }
            // Process stop action immediately
            this.startActionExecution(robotId, actionName);
        } else {
            // Check if another action is already in progress (for non-stop actions)
            if (this.isActionInProgress) {
                console.log(`⏸️ Action ${actionName} blocked - another action is in progress: ${this.currentActionName}`);
                this.showNotification(`Please wait - ${this.currentActionName} is still in progress`, 'warning');
                return;
            }

            // Start action execution (disable buttons)
            this.startActionExecution(robotId, actionName);
        }

        // Send action through REST API endpoint to ensure proper event handling
        fetch(`${this.apiUrlPrefix}/run_action/${robotId}?session_key=${this.sessionKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: actionName
            })
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    console.log(`✅ Action ${actionName} sent successfully to ${robotId}`);
                } else {
                    console.error(`❌ Failed to send action: ${data.error}`);
                    this.showNotification(`Failed to send action: ${data.error}`, 'error');
                    // Re-enable buttons on error
                    this.enableActionButtons();
                }
            })
            .catch(error => {
                console.error(`❌ Error sending action: ${error}`);
                this.showNotification(`Error sending action: ${error.message}`, 'error');
                // Re-enable buttons on error
                this.enableActionButtons();
            });
    }

    executeAction(actionName, robotId = 'all') {
        console.log(`🎬 Executing action: ${actionName} on ${robotId}`);

        // Send action to server using the new actions event
        this.sendActionByName(actionName, robotId);

        // Also update local UI immediately for responsiveness
        this.updateLastAction(robotId, actionName);
    }

    sendAction(robotId, action) {
        console.log(`📡 Sending action: ${action} to ${robotId} in session: ${this.sessionKey}`);

        // Special handling for stop action - it should interrupt any running action
        if (action === 'stop') {
            if (this.isActionInProgress) {
                console.log(`🛑 Stop action interrupting current action: ${this.currentActionName}`);
                this.showNotification(`Stopping current action: ${this.currentActionName}`, 'info');
                // Stop current action and clear queue
                this.stopCurrentAction();
            }
            // Process stop action immediately
            this.startActionExecution(robotId, action);
        } else {
            // Check if another action is already in progress (for non-stop actions)
            if (this.isActionInProgress) {
                console.log(`⏸️ Action ${action} blocked - another action is in progress: ${this.currentActionName}`);
                this.showNotification(`Please wait - ${this.currentActionName} is still in progress`, 'warning');
                return;
            }

            // Start action execution (disable buttons)
            this.startActionExecution(robotId, action);
        }

        // Send action through REST API endpoint to ensure proper event handling
        fetch(`${this.apiUrlPrefix}/run_action/${robotId}?session_key=${this.sessionKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: action
            })
        })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    console.log(`✅ Action ${action} sent successfully to ${robotId}`);
                } else {
                    console.error(`❌ Failed to send action: ${data.error}`);
                    this.showNotification(`Failed to send action: ${data.error}`, 'error');
                    // Re-enable buttons on error
                    this.enableActionButtons();
                }
            })
            .catch(error => {
                console.error(`❌ Error sending action: ${error}`);
                this.showNotification(`Error sending action: ${error.message}`, 'error');
                // Re-enable buttons on error
                this.enableActionButtons();
            });
    }

    resetSession() {
        console.log(`🔄 Resetting session: ${this.sessionKey}`);

        // Show confirmation dialog
        if (!confirm('Are you sure you want to reset the session? This will move all robots back to their initial positions.')) {
            return;
        }

        if (this.socket && this.isConnected) {
            this.socket.send(JSON.stringify({
                action: 'reset_session',
                session_key: this.sessionKey
            }));
        } else {
            console.log('⚠️ WebSocket not connected, cannot reset session');
            this.showNotification('Cannot reset session - not connected to server', 'error');

            // If not connected, still perform local force refresh
            this.forceRefresh();
        }
    }

    forceRefresh() {
        console.log('🔄 Force refreshing robots...');

        // Add test robots to ensure they're in the scene
        this.addTestRobots();

        // If connected to WebSocket, request robot states
        if (this.socket && this.isConnected && this.sessionKey) {
            this.socket.send(JSON.stringify({
                action: 'get_robot_states',
                session_key: this.sessionKey
            }));
        }

        // Show notification
        this.showNotification('Robots refreshed successfully!', 'success');
    }

    toggleControlPanel() {
        const controlPanel = document.getElementById('control-panel');
        const toggleBtn = document.getElementById('toggle-panel');

        if (!controlPanel || !toggleBtn) {
            console.error('❌ Required elements not found for panel toggle');
            return;
        }

        const isVisible = controlPanel.classList.contains('visible');

        if (isVisible) {
            // Hide the panel
            controlPanel.classList.remove('visible');
            toggleBtn.textContent = '📋 Show Panel';
            console.log('📱 Control panel hidden');
        } else {
            // Show the panel
            controlPanel.classList.add('visible');
            toggleBtn.textContent = '📋 Hide Panel';
            console.log('📱️ Control panel shown');
        }

        // Trigger canvas resize after animation completes
        setTimeout(() => {
            this.forceCanvasResize();
        }, 300); // Match the CSS transition duration
    }

    resizeCanvas() {
        if (this.scene3d) {
            // console.log('🖼️ Resizing 3D canvas to fit new viewport dimensions');

            // Get the canvas element and its container to check dimensions
            const canvas = document.getElementById('three-canvas');
            const viewportContainer = document.getElementById('viewport-container');

            if (canvas && viewportContainer) {
                // Get the actual container dimensions
                const containerWidth = viewportContainer.clientWidth;
                const containerHeight = viewportContainer.clientHeight;

                // console.log(`📏 Viewport container size: ${containerWidth}x${containerHeight}`);
                // console.log(`📏 Canvas current size: ${canvas.clientWidth}x${canvas.clientHeight}`);

                // Force the canvas to match container dimensions
                canvas.style.width = containerWidth + 'px';
                canvas.style.height = containerHeight + 'px';

                // Wait a frame for the DOM to update, then resize the 3D scene
                requestAnimationFrame(() => {
                    this.scene3d.onWindowResize();
                    // console.log(`✅ Canvas resized to: ${canvas.clientWidth}x${canvas.clientHeight}`);
                });
            }
        } else {
            console.warn('⚠️ Scene3D not available for resize');
        }
    }

    forceCanvasResize() {
        // Force a canvas resize with optimized timing to reduce performance impact
        // Only resize if we haven't resized recently
        const now = Date.now();
        if (this.lastResizeTime && now - this.lastResizeTime < 500) {
            return; // Prevent excessive resize calls
        }
        this.lastResizeTime = now;

        // Immediate resize
        this.resizeCanvas();

        // Single delayed resize to handle CSS transitions
        setTimeout(() => {
            this.resizeCanvas();
        }, 100);
    }

    checkAndFixCanvasSize() {
        // Utility method to check if canvas size matches container and fix if needed
        const canvas = document.getElementById('three-canvas');
        const viewportContainer = document.getElementById('viewport-container');

        if (!canvas || !viewportContainer) return;

        const containerWidth = viewportContainer.clientWidth;
        const containerHeight = viewportContainer.clientHeight;
        const canvasWidth = canvas.clientWidth;
        const canvasHeight = canvas.clientHeight;

        // Check if sizes don't match (with small tolerance for rounding)
        if (Math.abs(containerWidth - canvasWidth) > 2 || Math.abs(containerHeight - canvasHeight) > 2) {
            // Only log occasionally to avoid spam
            if (!this.lastSizeLogTime || Date.now() - this.lastSizeLogTime > 5000) {
                console.log(`🔧 Canvas size mismatch detected. Container: ${containerWidth}x${containerHeight}, Canvas: ${canvasWidth}x${canvasHeight}`);
                this.lastSizeLogTime = Date.now();
            }
            this.forceCanvasResize();
            return true; // Resize was needed
        }

        return false; // No resize needed
    }

    startCanvasSizeMonitoring() {
        // Periodically check if canvas size matches container and fix if needed
        // Reduced frequency to avoid performance issues
        setInterval(() => {
            if (this.scene3d) {
                this.checkAndFixCanvasSize();
            }
        }, 2000); // Check every 2 seconds instead of 1

        console.log('📏 Canvas size monitoring started');
    }

    handleActionResult(result) {
        console.log('📨 Handling action result:', result);

        // Update UI to show action feedback
        const statusElement = document.getElementById('action-status');
        if (statusElement) {
            statusElement.textContent = `${result.status}: ${result.action}`;
            statusElement.className = result.status === 'success' ? 'success' : 'error';
            setTimeout(() => {
                statusElement.textContent = '';
                statusElement.className = '';
            }, 3000);
        }
    }

    handleResetResult(result) {
        console.log('🔄 Handling reset result:', result);

        // Show notification
        if (result.status === 'success') {
            this.showNotification('Session reset successfully! All robots moved to initial positions.', 'success');

            // Update last action display
            this.updateLastAction('all', 'reset');

            // After successful reset, perform force refresh
            console.log('🔄 Performing force refresh after reset...');
            this.forceRefresh();
        } else {
            this.showNotification(`Reset failed: ${result.message}`, 'error');
        }

        // Update status
        const statusElement = document.getElementById('action-status');
        if (statusElement) {
            statusElement.textContent = `${result.status}: session reset`;
            statusElement.className = result.status === 'success' ? 'success' : 'error';
            setTimeout(() => {
                statusElement.textContent = '';
                statusElement.className = '';
            }, 3000);
        }
    }

    handleServerActionRequest(data) {
        console.log('🎬 Handling server action request:', data);

        const actionName = data.action_name || 'stand';
        const robotId = data.robot_id || 'all';
        const motions = data.motions || {};
        const actionIds = data.action_ids || {};

        // Check if this is a speech action with an audio URL
        if (actionName === 'speech' && data.audio_url) {
            this.handleSpeechAudio(data);
            return;
        }

        // Execute the action LOCALLY only - don't send back to server to avoid loop
        this.triggerLocalAction(robotId, actionName, motions, actionIds);

        // Show notification about server-initiated action
        this.showNotification(`Server executed "${actionName}" on ${robotId}`, 'info');

        // Update last action display
        this.updateLastAction(robotId, actionName);

        console.log(`✅ Server action "${actionName}" executed locally on ${robotId}`);
    }

    /**
     * Handle speech audio from IoT (Polly TTS).
     * Plays the presigned S3 URL via the per-robot SpeechPlayer.
     * Multiple robots can speak concurrently; new speech for the
     * same robot interrupts its previous speech.
     * @param {Object} data - { audio_url, text, robot_id }
     */
    handleSpeechAudio(data) {
        const audioUrl = data.audio_url;
        const text = data.text || '';
        const robotId = data.robot_id || 'unknown';

        if (!audioUrl) {
            console.warn('🔊 Speech event received without audio_url');
            return;
        }

        if (robotId !== 'all' && !this.robots.has(robotId)) {
            console.log(`🔊 Ignoring speech for ${robotId} as it is not in the current scene.`);
            return;
        }

        console.log(`🔊 Playing speech for ${robotId}: "${text}"`);

        if (window.speechPlayer) {
            window.speechPlayer.play(robotId, audioUrl, text);
        } else {
            console.warn('🔊 SpeechPlayer not available');
        }

        this.updateLastAction(robotId, `speech: "${text.substring(0, 30)}..."`);
    }

    /**
     * Handle video source change from server
     * @param {Object} data - Video source change data
     */
    handleVideoSourceChange(data) {
        console.log('📺 Handling video source change:', data);

        let { video_src, session_key } = data;

        if (!video_src) {
            console.warn('📺 No video source provided');
            return;
        }

        // Apply cache busting if enabled
        if (this.forceVideoReload) {
            const separator = video_src.includes('?') ? '&' : '?';
            video_src = `${video_src}${separator}cv=${this.videoCacheKey}`;
            console.log('🔄 Applied controlled cache buster to video URL:', video_src);
        }

        // Change video source in the 3D scene
        if (this.scene3d) {
            this.scene3d.changeVideoSource(video_src);
            this.showNotification(`Video source changed to: ${video_src}`, 'info');
        } else {
            console.warn('📺 No 3D scene available to change video source');
        }
    }

    /**
     * Handle video control commands from server
     * @param {Object} data - Video control data
     */
    handleVideoControl(data) {
        console.log('📺 Handling video control:', data);

        const { action, session_key } = data;

        if (!this.scene3d) {
            console.warn('📺 No 3D scene available for video control');
            return;
        }

        switch (action) {
            case 'play':
                this.scene3d.playVideo();
                this.showNotification('Video playing', 'success');
                break;
            case 'pause':
                this.scene3d.pauseVideo();
                this.showNotification('Video paused', 'info');
                break;
            case 'toggle':
                this.scene3d.toggleVideo();
                this.showNotification('Video toggled', 'info');
                break;
            default:
                console.warn('📺 Unknown video control action:', action);
        }
    }

    /**
     * Handle camera control commands from server/hand controller
     * @param {Object} data - Camera control data
     */
    handleCameraControl(data) {
        if (!this.scene3d) {
            console.warn('📷 No 3D scene available for camera control');
            return;
        }

        const { type, params } = data;
        console.log(`📷 Camera control logic processing: ${type}`, params);

        switch (type) {
            case 'rotate':
                this.scene3d.rotateCamera(params.dx, params.dy, 0.05);
                break;
            case 'zoom':
                this.scene3d.zoomCamera(params.delta, 2.0);
                break;
            case 'pan':
                this.scene3d.panCamera(params.dx, params.dy, 0.05);
                break;
            case 'reset':
                console.log('📷 EXECUTING CAMERA RESET');
                this.scene3d.resetCamera();
                break;
            default:
                console.warn('📷 Unknown camera control type:', type);
        }
    }

    updateLastAction(robotId, action) {
        const lastActionElement = document.getElementById('last-action');
        if (lastActionElement) {
            const timestamp = new Date().toLocaleTimeString();
            lastActionElement.textContent = `${action} on ${robotId} at ${timestamp}`;
        }
    }

    updateConnectionStatus(connected) {
        const statusElement = document.getElementById('connection-status');
        if (statusElement) {
            statusElement.textContent = connected ? '🟢 Connected' : '🔴 Disconnected';
            statusElement.className = connected ? 'connected' : 'disconnected';
        }
    }

    updateRobotCount() {
        const countElement = document.getElementById('robot-count');
        if (countElement) {
            countElement.textContent = `Robots: ${this.robots.size}/6`;
        }
    }

    showNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;

        // Style the notification
        Object.assign(notification.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            padding: '12px 20px',
            borderRadius: '6px',
            color: 'white',
            fontWeight: 'bold',
            zIndex: '10000',
            opacity: '0',
            transition: 'opacity 0.3s ease',
            maxWidth: '300px'
        });

        // Set background color based on type
        switch (type) {
            case 'success':
                notification.style.background = 'linear-gradient(135deg, #2ed573, #1dd1a1)';
                break;
            case 'error':
                notification.style.background = 'linear-gradient(135deg, #ff4757, #ff3838)';
                break;
            case 'warning':
                notification.style.background = 'linear-gradient(135deg, #ffa502, #ff6348)';
                break;
            default:
                notification.style.background = 'linear-gradient(135deg, #4A90E2, #357ABD)';
        }

        // Add to page
        document.body.appendChild(notification);

        // Fade in
        setTimeout(() => {
            notification.style.opacity = '1';
        }, 100);

        // Remove after 3 seconds
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    }

    updateRobotSelectorFromList(robotList) {
        const robotSelect = document.getElementById('robot-select');
        if (!robotSelect) return;

        // Clear existing options except "all"
        robotSelect.innerHTML = '<option value="all">All Robots</option>';

        // Add robots from list
        robotList.forEach(robotId => {
            const option = document.createElement('option');
            option.value = robotId;
            option.textContent = robotId.replace('_', ' ').toUpperCase();
            robotSelect.appendChild(option);
        });

        // Update robot count
        this.updateRobotCount();

        console.log(`🔄 Robot selector updated with ${robotList.length} robots`);
    }

    // Action Queue Management Methods
    queueAction(robotId, action) {
        const queueItem = {
            robotId: robotId,
            action: action,
            timestamp: Date.now()
        };

        this.actionQueue.push(queueItem);
        console.log(`📋 Action queued: ${action} for ${robotId}. Queue length: ${this.actionQueue.length}`);

        // Start processing if not already processing
        if (!this.isProcessingQueue) {
            this.processActionQueue();
        }
    }

    async processActionQueue() {
        if (this.isProcessingQueue || this.actionQueue.length === 0) {
            return;
        }

        // Check if a single action is in progress
        if (this.isActionInProgress) {
            console.log('⏸️ Queue processing paused - waiting for current action to complete');
            return;
        }

        this.isProcessingQueue = true;
        console.log('🏃 Starting action queue processing...');

        while (this.actionQueue.length > 0) {
            const queueItem = this.actionQueue.shift();
            const { robotId, action } = queueItem;

            console.log(`⚡ Processing action: ${action} for ${robotId}`);

            // Start action execution (disable buttons)
            this.startActionExecution(robotId, action);

            // Send action to backend API instead of local processing
            try {
                const response = await fetch(`${this.apiUrlPrefix}/run_action/${robotId}?session_key=${this.sessionKey}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        action: action
                    })
                });

                const data = await response.json();
                if (data.success) {
                    console.log(`✅ Action ${action} sent successfully to ${robotId} via backend`);
                } else {
                    console.error(`❌ Failed to send action via backend: ${data.error}`);
                }
            } catch (error) {
                console.error(`❌ Error sending action via backend: ${error}`);
            }

            // Update last action display
            this.updateLastAction(robotId, action);

            // Get action duration
            const duration = this.getActionDuration(action);
            console.log(`⏱️ Waiting ${duration} seconds for action: ${action}`);

            // Wait for the action to complete
            await this.sleep(duration * 1000);

            // Complete the action (re-enable buttons)
            this.enableActionButtons();

            console.log(`✅ Action completed: ${action} for ${robotId}`);
        }

        this.isProcessingQueue = false;
        console.log('🏁 Action queue processing completed');
    }

    getActionDuration(action) {
        const actionKey = action.toLowerCase();
        return this.actionDurations[actionKey] || this.actionDurations['default'];
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    clearActionQueue() {
        this.actionQueue = [];
        console.log('🗑️ Action queue cleared');
    }

    getQueueStatus() {
        return {
            queueLength: this.actionQueue.length,
            isProcessing: this.isProcessingQueue,
            nextAction: this.actionQueue.length > 0 ? this.actionQueue[0] : null
        };
    }

    // Helper function to queue multiple actions in sequence
    queueMultipleActions(robotId, actions) {
        if (!Array.isArray(actions)) {
            console.error('❌ Actions must be an array');
            return;
        }

        console.log(`📋 Queuing ${actions.length} actions for ${robotId}:`, actions);

        actions.forEach(action => {
            this.queueAction(robotId, action);
        });

        // Calculate total duration
        let totalDuration = 0;
        actions.forEach(action => {
            totalDuration += this.getActionDuration(action);
        });

        console.log(`⏱️ Total sequence duration: ${totalDuration} seconds`);
        return totalDuration;
    }

    // Predefined action sequences based on action types
    queueDanceSequence(robotId) {
        const danceActions = [
            'dance_two',    // 52 seconds
            'dance_three',  // 70 seconds 
            'dance_four',   // 59 seconds
            'dance_five',   // 59 seconds
            'dance_six',    // 69 seconds
            'dance_seven',  // 67 seconds
            'dance_eight',  // 85 seconds
            'dance_nine',   // 84 seconds
            'dance_ten'     // 85 seconds
        ];
        return this.queueMultipleActions(robotId, danceActions);
    }

    queueCombatSequence(robotId) {
        const combatActions = [
            'right_kick',     // 2 seconds
            'left_kick',      // 2 seconds
            'right_uppercut', // 2 seconds
            'left_uppercut',  // 2 seconds
            'wing_chun',      // 2 seconds
            'right_shot_fast', // 4 seconds
            'left_shot_fast', // 4 seconds
            'kung_fu'         // 2 seconds
        ];
        return this.queueMultipleActions(robotId, combatActions);
    }

    queueExerciseSequence(robotId) {
        const exerciseActions = [
            'chest',        // 9 seconds
            'squat_up',     // 6 seconds
            'squat',        // 1 second
            'push_ups',     // 9 seconds
            'sit_ups',      // 12 seconds
            'weightlifting' // 9 seconds
        ];
        return this.queueMultipleActions(robotId, exerciseActions);
    }

    queueMovementSequence(robotId) {
        const movementActions = [
            'stepping',        // 3 seconds
            'twist',          // 4 seconds
            'go_forward',     // 3.5 seconds
            'turn_right',     // 4 seconds
            'go_forward',     // 3.5 seconds
            'turn_left',      // 4 seconds
            'back_fast',      // 4.5 seconds
            'right_move_fast', // 3 seconds
            'left_move_fast'   // 3 seconds
        ];
        return this.queueMultipleActions(robotId, movementActions);
    }

    // Function to demonstrate exact timing according to Python backend
    demonstrateTimingSequence(robotId) {
        console.log('🎭 Starting demonstration of exact timing sequence...');

        const allActions = [
            // Long dance sequences
            'dance_two',       // 52 seconds
            'dance_three',     // 70 seconds
            'dance_four',      // 59 seconds
            'dance_five',      // 59 seconds
            'dance_six',       // 69 seconds
            'dance_seven',     // 67 seconds
            'dance_eight',     // 85 seconds
            'dance_nine',      // 84 seconds
            'dance_ten',       // 85 seconds

            // Quick movements
            'stepping',        // 3 seconds
            'twist',          // 4 seconds
            'stand_up_back',  // 5 seconds
            'stand_up_front', // 5 seconds

            // Combat moves
            'right_kick',     // 2 seconds
            'left_kick',      // 2 seconds
            'right_uppercut', // 2 seconds
            'left_uppercut',  // 2 seconds
            'wing_chun',      // 2 seconds
            'right_shot_fast', // 4 seconds
            'left_shot_fast', // 4 seconds

            // Exercises
            'chest',          // 9 seconds
            'squat_up',       // 6 seconds
            'squat',          // 1 second
            'bow',            // 4 seconds
            'wave',           // 3.5 seconds
            'turn_right',     // 4 seconds
            'turn_left',      // 4 seconds
            'sit_ups',        // 12 seconds
            'right_move_fast', // 3 seconds
            'left_move_fast', // 3 seconds
            'back_fast',      // 4.5 seconds
            'go_forward',     // 3.5 seconds
            'push_ups',       // 9 seconds
            'weightlifting',  // 9 seconds
            'kung_fu',        // 2 seconds

            // Additional backend actions
            'stand',          // 1 second
            'stop'            // 3 seconds
        ];

        return this.queueMultipleActions(robotId, allActions);
    }

    // Enhanced timing demonstration functions
    demonstrateActionCategories(robotId = 'all') {
        console.log('🎭 Starting enhanced action category demonstration...');

        const categories = {
            'Quick Combat Moves (2-4s)': ['right_kick', 'left_kick', 'kung_fu', 'wing_chun'],
            'Basic Gestures (3-4s)': ['wave', 'bow', 'twist', 'stepping'],
            'Movement Actions (3-5s)': ['go_forward', 'turn_left', 'turn_right', 'stand_up_back'],
            'Exercise Routines (6-12s)': ['squat_up', 'chest', 'push_ups', 'weightlifting', 'sit_ups'],
            'Moderate Dances (52-69s)': ['dance_two', 'dance_four', 'dance_five', 'dance_six'],
            'Long Dances (70-85s)': ['dance_three', 'dance_seven', 'dance_eight', 'dance_nine', 'dance_ten']
        };

        Object.entries(categories).forEach(([categoryName, actions], categoryIndex) => {
            console.log(`\n📂 Category ${categoryIndex + 1}: ${categoryName}`);
            actions.forEach((action, actionIndex) => {
                const duration = this.getActionDuration(action);
                console.log(`  ⏱️ ${action}: ${duration}s`);
            });
        });

        return categories;
    }

    demonstrateTimingPrecision(robotId = 'all') {
        console.log('🔧 Demonstrating enhanced animation timing precision...');

        // Test sequence showing timing accuracy
        const testSequence = [
            { action: 'squat', expectedDuration: 1 },      // Very quick
            { action: 'kung_fu', expectedDuration: 2 },    // Quick combat
            { action: 'wave', expectedDuration: 3.5 },     // Basic gesture
            { action: 'turn_right', expectedDuration: 4 }, // Movement
            { action: 'chest', expectedDuration: 9 },      // Exercise
            { action: 'sit_ups', expectedDuration: 12 },   // Long exercise
            { action: 'dance_two', expectedDuration: 52 }  // Dance sequence
        ];

        console.log('🎯 Timing precision test sequence:');
        testSequence.forEach((item, index) => {
            const actualDuration = this.getActionDuration(item.action);
            const isAccurate = actualDuration === item.expectedDuration;
            console.log(`  ${index + 1}. ${item.action}: Expected ${item.expectedDuration}s, Actual ${actualDuration}s ${isAccurate ? '✅' : '❌'}`);
        });

        return testSequence;
    }

    queuePhasedDanceDemo(robotId = 'all') {
        console.log('💃 Starting phased dance demonstration with precise timing...');

        // Demonstrate the new phased animation system with different dance complexities
        const danceProgression = [
            'dance_two',    // 52s - Short/Medium dance with 4-5 phases
            'dance_four',   // 59s - Medium dance 
            'dance_six',    // 69s - Extended dance
            'dance_three',  // 70s - Long dance
            'dance_eight',  // 85s - Maximum complexity dance
        ];

        let totalTime = 0;
        danceProgression.forEach(dance => {
            totalTime += this.getActionDuration(dance);
        });

        console.log(`🕺 Total dance progression duration: ${totalTime} seconds (${(totalTime / 60).toFixed(1)} minutes)`);

        return this.queueMultipleActions(robotId, danceProgression);
    }

    // Enhanced action queuing with timing analysis
    queueActionWithTimingAnalysis(robotId, action) {
        const duration = this.getActionDuration(action);
        const category = this.getActionCategory(action);

        console.log(`📊 Timing Analysis for ${action}:`);
        console.log(`  ⏱️ Duration: ${duration} seconds`);
        console.log(`  📂 Category: ${category}`);
        console.log(`  🎭 Animation Style: ${this.getAnimationStyle(action)}`);

        this.queueAction(robotId, action);
        return duration;
    }

    getActionCategory(action) {
        const duration = this.getActionDuration(action);

        if (action.startsWith('dance_')) {
            return duration > 75 ? 'Long Dance' : duration > 60 ? 'Extended Dance' : 'Moderate Dance';
        } else if (['chest', 'squat_up', 'push_ups', 'sit_ups', 'weightlifting'].includes(action)) {
            return 'Exercise';
        } else if (['right_kick', 'left_kick', 'kung_fu', 'wing_chun', 'right_uppercut', 'left_uppercut'].includes(action)) {
            return 'Combat';
        } else if (['go_forward', 'turn_left', 'turn_right', 'stepping', 'twist'].includes(action)) {
            return 'Movement';
        } else {
            return 'Basic Action';
        }
    }

    getAnimationStyle(action) {
        if (action.startsWith('dance_')) return 'Complex Multi-Phase';
        if (['right_kick', 'left_kick', 'kung_fu', 'wing_chun'].includes(action)) return 'Sharp Combat';
        if (['chest', 'push_ups', 'sit_ups', 'weightlifting'].includes(action)) return 'Repetitive Exercise';
        if (['go_forward', 'turn_left', 'turn_right'].includes(action)) return 'Smooth Movement';
        return 'Basic Gesture';
    }

    // Action management system to disable buttons during action execution
    startActionExecution(action, robotId) {
        console.log(`▶️ Starting action execution: ${action} for ${robotId}`);

        this.isActionInProgress = true;
        this.currentActionRobot = robotId;
        this.currentActionName = action;
        this.actionStartTime = Date.now();

        // Disable all action buttons
        const actionButtons = document.querySelectorAll('.action-btn');
        actionButtons.forEach(button => {
            button.disabled = true;
        });

        // Highlight the currently executing action button
        const activeButton = document.querySelector(`.action-btn[data-action="${action}"]`);
        if (activeButton) {
            activeButton.classList.add('active');
        }

        // Set a timeout to re-enable buttons after the action duration
        const duration = this.getActionDuration(action);
        this.actionTimeoutId = setTimeout(() => {
            this.endActionExecution();
        }, duration * 1000);
    }

    endActionExecution() {
        console.log(`⏹️ Ending action execution: ${this.currentActionName} for ${this.currentActionRobot}`);

        this.isActionInProgress = false;
        this.currentActionRobot = null;
        this.currentActionName = null;
        this.actionStartTime = null;

        // Re-enable all action buttons
        const actionButtons = document.querySelectorAll('.action-btn');
        actionButtons.forEach(button => {
            button.disabled = false;
        });

        // Remove active class from all buttons
        actionButtons.forEach(button => {
            button.classList.remove('active');
        });

        clearTimeout(this.actionTimeoutId);
        this.actionTimeoutId = null;
    }

    // Add methods for managing button states

    disableActionButtons() {
        console.log('🚫 Disabling action buttons...');
        // Disable all action buttons except UI controls and stop button
        const actionButtons = document.querySelectorAll('.action-btn:not(.sequence-btn):not(#toggle-panel):not(#reset-camera):not(#reset):not([data-action="stop"])');
        actionButtons.forEach(button => {
            button.disabled = true;
            button.style.opacity = '0.5';
            button.style.cursor = 'not-allowed';
        });

        // Enable stop button when action is running
        this.enableStopButton();
    }

    enableActionButtons() {
        console.log('✅ Enabling action buttons...');
        const actionButtons = document.querySelectorAll('.action-btn:not(.sequence-btn):not(#toggle-panel):not(#reset-camera):not(#reset)');
        actionButtons.forEach(button => {
            button.disabled = false;
            button.style.opacity = '1';
            button.style.cursor = 'pointer';
        });

        // Disable stop button when no action is running
        this.disableStopButton();

        // Clear action state
        this.isActionInProgress = false;
        this.currentActionRobot = null;
        this.currentActionName = null;
        this.actionStartTime = null;

        // Clear any pending timeout
        if (this.actionTimeoutId) {
            clearTimeout(this.actionTimeoutId);
            this.actionTimeoutId = null;
        }
    }

    startActionExecution(robotId, actionName) {
        console.log(`🚀 Starting action execution: ${actionName} for ${robotId}`);

        // Set action state
        this.isActionInProgress = true;
        this.currentActionRobot = robotId;
        this.currentActionName = actionName;
        this.actionStartTime = Date.now();

        // Disable all action buttons
        this.disableActionButtons();

        // Get action duration and set a safety timeout
        const duration = this.getActionDuration(actionName);
        const timeoutDuration = (duration + 2) * 1000; // Add 2 seconds buffer

        this.actionTimeoutId = setTimeout(() => {
            console.log(`⚠️ Action timeout reached for ${actionName}, re-enabling buttons`);
            this.enableActionButtons();
        }, timeoutDuration);

        console.log(`⏱️ Action will timeout in ${timeoutDuration / 1000} seconds`);
    }

    completeActionExecution() {
        console.log(`✅ Completing action execution: ${this.currentActionName} for ${this.currentActionRobot}`);
        this.enableActionButtons();
    }

    enableStopButton() {
        const stopButton = document.querySelector('[data-action="stop"]');
        if (stopButton) {
            stopButton.disabled = false;
            stopButton.style.opacity = '1';
            stopButton.style.cursor = 'pointer';
            console.log('🔴 Stop button enabled');
        }
    }

    disableStopButton() {
        const stopButton = document.querySelector('[data-action="stop"]');
        if (stopButton) {
            stopButton.disabled = true;
            stopButton.style.opacity = '0.5';
            stopButton.style.cursor = 'not-allowed';
            console.log('⏹️ Stop button disabled');
        }
    }

    stopCurrentAction() {
        console.log('🛑 Stopping current action and clearing queue...');

        // Clear any running action timeout
        if (this.actionTimeoutId) {
            clearTimeout(this.actionTimeoutId);
            this.actionTimeoutId = null;
        }

        // Clear the action queue
        this.clearActionQueue();

        // Stop queue processing
        this.isProcessingQueue = false;

        // Clear action state and re-enable buttons
        this.enableActionButtons();

        console.log('✅ Current action stopped and queue cleared');
    }
}

// Initialize simulator when page loads
document.addEventListener('DOMContentLoaded', () => {
    console.log('📄 DOM loaded, starting simulator...');
    // Initialize simulator and make it globally available
    window.simulator = new HumanoidSimulator();
    window.humanoidSimulator = window.simulator; // Also provide with the name expected by animations
});

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && window.simulator) {
        console.log('👁️ Page visible, refreshing robots...');
        if (window.simulator.socket && window.simulator.isConnected && window.simulator.sessionKey) {
            window.simulator.socket.send(JSON.stringify({
                action: 'get_robot_states',
                session_key: window.simulator.sessionKey
            }));
        }
    }
});

console.log('🚀 Enhanced 34-Action Robot Simulator loaded successfully - Python Backend Synchronized');
