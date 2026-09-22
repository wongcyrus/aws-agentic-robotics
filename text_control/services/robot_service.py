"""
Robot service - Handles robot action execution

This module provides a refactored robot service with improved structure,
better error handling, and separation of concerns.
"""

import json
import os
import uuid as uuid_mod
from concurrent.futures import ThreadPoolExecutor, as_completed
from time import sleep
from typing import Any, Dict, List

import boto3
from botocore.config import Config
from models.actions import get_available_actions
from utils.lambda_logger import get_lambda_logger
from utils.observability import Metric, MetricsEmitter

from .publishers import (
    DogPublisher,
    DronePublisher,
    RobotPublisher,
    StandardRobotPublisher,
)
from .robot_config import ACTION_DELAY, DOG_IDS, DRONE_IDS, ROBOT_RANGE

# Configure logging for AWS Lambda
logger = get_lambda_logger(__name__)


class RobotService:
    """Main service class for robot operations"""

    def __init__(
        self,
        robot_publisher=None,
        drone_publisher=None,
        dog_publisher=None,
        executor_factory=None,
        action_loader=None,
        sleep_fn=None,
        client_factory=None,
        uuid_factory=None,
        metrics_emitter=None,
    ):
        self.robot_publisher = robot_publisher or StandardRobotPublisher()
        self.drone_publisher = drone_publisher or DronePublisher()
        self.dog_publisher = dog_publisher or DogPublisher()
        self._executor_factory = executor_factory or ThreadPoolExecutor
        self._action_loader = action_loader or get_available_actions
        self._sleep = sleep_fn or sleep
        self._client_factory = client_factory or boto3.client
        self._uuid_factory = uuid_factory or uuid_mod.uuid4
        self._metrics = metrics_emitter or MetricsEmitter(
            namespace="AwsAgenticRobotics",
            service="text-control",
        )

    def _get_robot_ids(self) -> List[str]:
        """Get list of robot IDs"""
        return [f"robot_{i}" for i in ROBOT_RANGE]

    def _execute_parallel_actions(
        self,
        robot_ids: List[str],
        message: str,
        publisher: RobotPublisher,
        parameters: Dict[str, Any] = None,
    ) -> bool:
        """Execute actions in parallel for multiple robots"""
        with self._executor_factory() as executor:
            futures = {
                executor.submit(
                    publisher.publish, robot_id, message, parameters
                ): robot_id
                for robot_id in robot_ids
            }
            results = []

            for future in as_completed(futures):
                robot_id = futures[future]
                try:
                    result = future.result()
                    results.append(result)
                except Exception as e:
                    logger.error("Error executing action for %s: %s", robot_id, e)
                    results.append(False)

            return all(results)

    def execute_robot_action(
        self, message: str, selected_robot: str, parameters: Dict[str, Any] = None
    ) -> bool:
        """Execute a robot action by publishing to the appropriate IoT topic with enhanced routing"""
        logger.info(
            f"execute_robot_action called with message={message}, selected_robot={selected_robot}, parameters={parameters}"
        )

        try:
            # Validate inputs
            if not message or not selected_robot:
                logger.error("Invalid input: message and selected_robot are required")
                return False

            # Route to appropriate publisher based on robot type
            if selected_robot == "all_robots":
                logger.info("Executing action for all standard robots")
                robot_ids = self._get_robot_ids()
                return self._execute_parallel_actions(
                    robot_ids, message, self.robot_publisher, parameters
                )

            elif selected_robot == "all_drones":
                logger.info("Executing action for all drones")
                return self._execute_parallel_actions(
                    DRONE_IDS, message, self.drone_publisher, parameters
                )

            elif selected_robot in DRONE_IDS:
                logger.info(f"Executing action for individual drone: {selected_robot}")
                return self.drone_publisher.publish(selected_robot, message, parameters)

            elif selected_robot == "all_dogs":
                logger.info("Executing action for all dogs")
                return self._execute_parallel_actions(
                    DOG_IDS, message, self.dog_publisher, parameters
                )

            elif selected_robot in DOG_IDS:
                logger.info(f"Executing action for individual dog: {selected_robot}")
                return self.dog_publisher.publish(selected_robot, message, parameters)

            elif selected_robot.startswith("robot_"):
                logger.info(f"Executing action for standard robot: {selected_robot}")
                return self.robot_publisher.publish(selected_robot, message, parameters)

            else:
                logger.warning(
                    f"Unknown robot type for {selected_robot}, trying default robot publisher"
                )
                return self.robot_publisher.publish(selected_robot, message, parameters)

        except Exception as e:
            logger.error(f"Error executing robot action: {e}", exc_info=True)
            return False

    def execute_dog_action(
        self, dog_id: str, action: str, parameters: Dict[str, Any] = None
    ) -> bool:
        """
        Execute a specific dog action with parameters.

        This method provides a direct interface for dog actions, bypassing
        the general robot action routing.

        Args:
            dog_id: ID of the dog robot (e.g., "dog_1", "dog_2", "dog_3")
            action: Action name (e.g., "move_forward", "rotate_left")
            parameters: Action parameters (e.g., {"distance": 100, "speed": 0.5})

        Returns:
            True if action was successfully published, False otherwise
        """
        logger.info(
            f"execute_dog_action called with dog_id={dog_id}, action={action}, parameters={parameters}"
        )

        try:
            # Validate dog ID
            if dog_id not in DOG_IDS and dog_id != "all":
                logger.error(
                    f"Invalid dog ID: {dog_id}. Valid IDs: {DOG_IDS + ['all']}"
                )
                return False

            # Handle "all" dogs
            if dog_id == "all":
                return self._execute_parallel_actions(
                    DOG_IDS, action, self.dog_publisher, parameters
                )

            # Execute for specific dog
            return self.dog_publisher.publish(dog_id, action, parameters)

        except Exception as e:
            logger.error(f"Error executing dog action: {e}", exc_info=True)
            return False

    async def process_actions(
        self,
        actions_to_execute: List[str],
        selected_robot: str,
        parameters: Dict[str, Any] = None,
    ) -> List[Dict[str, Any]]:
        """Process a list of actions sequentially with parameter support"""
        results = []

        try:
            available_actions = await self._action_loader()

            for action in actions_to_execute:
                if action in available_actions:
                    success = self.execute_robot_action(
                        action, selected_robot, parameters
                    )
                    results.append(
                        {"robot": selected_robot, "action": action, "success": success}
                    )
                    self._sleep(ACTION_DELAY)
                else:
                    logger.warning(f"Action '{action}' is not available")
                    results.append(
                        {
                            "robot": selected_robot,
                            "action": action,
                            "success": False,
                            "error": "Action not available",
                        }
                    )

            logger.info(f"Processed {len(results)} actions for {selected_robot}")
            return results

        except Exception as e:
            logger.error(f"Error processing actions: {e}", exc_info=True)
            return []

    def get_supported_dog_actions(self) -> List[str]:
        """Get list of supported dog actions"""
        return list(self.dog_publisher.action_mapping.keys())

    def get_robot_status(self, robot_id: str) -> Dict[str, Any]:
        """Get robot status information"""
        try:
            if robot_id in DOG_IDS:
                return {
                    "robot_id": robot_id,
                    "type": "dog",
                    "status": "active",
                    "supported_actions": self.get_supported_dog_actions(),
                }
            elif robot_id in DRONE_IDS:
                return {
                    "robot_id": robot_id,
                    "type": "drone",
                    "status": "active",
                    "supported_actions": list(
                        self.drone_publisher.action_mapping.keys()
                    ),
                }
            elif robot_id.startswith("robot_"):
                return {
                    "robot_id": robot_id,
                    "type": "standard_robot",
                    "status": "active",
                }
            else:
                return {"robot_id": robot_id, "type": "unknown", "status": "unknown"}
        except Exception as e:
            logger.error(f"Error getting robot status for {robot_id}: {e}")
            return {
                "robot_id": robot_id,
                "type": "unknown",
                "status": "error",
                "error": str(e),
            }

    def validate_dog_action(
        self, action: str, parameters: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Validate a dog action and its parameters.

        Returns:
            Dictionary with validation results
        """
        try:
            # Check if action is supported
            if action not in self.dog_publisher.action_mapping:
                return {
                    "valid": False,
                    "error": f"Unsupported action: {action}",
                    "supported_actions": self.get_supported_dog_actions(),
                }

            # Validate parameters
            mapping = self.dog_publisher.action_mapping[action]
            action_type = mapping["type"]

            validation_errors = []

            if parameters:
                if action_type == "movement":
                    if "distance" in parameters:
                        try:
                            distance = int(parameters["distance"])
                            if distance < 1 or distance > 1000:
                                validation_errors.append(
                                    "Distance must be between 1 and 1000 cm"
                                )
                        except (ValueError, TypeError):
                            validation_errors.append("Distance must be a valid integer")

                    if "speed" in parameters:
                        try:
                            speed = float(parameters["speed"])
                            if speed < 0.1 or speed > 1.0:
                                validation_errors.append(
                                    "Speed must be between 0.1 and 1.0"
                                )
                        except (ValueError, TypeError):
                            validation_errors.append("Speed must be a valid float")

                elif action_type == "rotation":
                    if "angle" in parameters:
                        try:
                            angle = int(parameters["angle"])
                            if angle < 1 or angle > 360:
                                validation_errors.append(
                                    "Angle must be between 1 and 360 degrees"
                                )
                        except (ValueError, TypeError):
                            validation_errors.append("Angle must be a valid integer")

            if validation_errors:
                return {"valid": False, "errors": validation_errors}

            return {
                "valid": True,
                "action_type": action_type,
                "mapped_action": mapping["action"],
            }

        except Exception as e:
            logger.error(f"Error validating dog action: {e}")
            return {"valid": False, "error": f"Validation error: {str(e)}"}

    def capture_image(self, robot_id: str) -> Dict[str, Any]:
        """Capture an image from a robot's camera.

        Generates a presigned S3 PUT URL, publishes a capture_image command
        with the URL to the robot via IoT, then polls S3 until the image is
        uploaded (every 0.5s, up to 15s).

        Returns:
            Dict with 'success', 'image_url' (presigned GET URL) or 'error'.
        """
        bucket = os.environ.get("MEDIA_BUCKET_NAME", "")
        if not bucket:
            logger.error("MEDIA_BUCKET_NAME not configured")
            return {"success": False, "error": "Image bucket not configured"}

        s3_client = self._client_factory(
            "s3", config=Config(
                retries={"max_attempts": 3, "mode": "standard"},
                signature_version="s3v4"
            )
        )
        iot_client = self._client_factory(
            "iot-data", config=Config(retries={"max_attempts": 3, "mode": "standard"})
        )

        # 1. Generate presigned PUT URL
        object_key = f"robot-images/{robot_id}/{self._uuid_factory()}.jpg"
        upload_url = s3_client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": bucket,
                "Key": object_key,
                "ContentType": "image/jpeg",
            },
            ExpiresIn=300,
        )

        # 2. Publish capture_image command with upload URL via IoT
        topic = f"{robot_id}/topic"
        payload = json.dumps({
            "toolName": "capture_image",
            "upload_url": upload_url,
        })
        try:
            iot_client.publish(
                topic=topic,
                qos=0,
                retain=False,
                payload=payload.encode("utf-8"),
            )
            logger.info("Published capture_image to %s", topic)
        except Exception as e:
            logger.error("Failed to publish capture_image to %s: %s", topic, e)
            self._metrics.emit(
                Metric("RobotCapturePublishFailure"),
                robotId=robot_id,
            )
            return {"success": False, "error": f"IoT publish failed: {e}"}

        # 3. Poll S3 every 0.5s for up to 15s
        elapsed = 0.0
        while elapsed < 15.0:
            try:
                s3_client.head_object(Bucket=bucket, Key=object_key)
                # Image uploaded — generate presigned GET URL
                read_url = s3_client.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": bucket, "Key": object_key},
                    ExpiresIn=300,
                )
                logger.info("Image uploaded by %s, presigned GET URL generated", robot_id)
                return {"success": True, "image_url": read_url}
            except s3_client.exceptions.ClientError:
                self._sleep(0.5)
                elapsed += 0.5

        logger.warning("Robot %s did not upload image within timeout", robot_id)
        self._metrics.emit(Metric("RobotCaptureTimeout"), robotId=robot_id)
        return {
            "success": False,
            "error": "Cannot read image from robot. The robot did not upload the image in time.",
        }


# Create service instance
robot_service = RobotService()
