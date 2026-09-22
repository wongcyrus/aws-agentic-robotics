#!/usr/bin/env python3
"""Session and authentication utilities for the Serverless Robot Simulator"""

import base64
import json
import logging
import os
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Optional
from urllib.parse import unquote_plus
from zoneinfo import ZoneInfo

import requests
import boto3
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

logger = logging.getLogger(__name__)

_ROBOT_API_URL = os.getenv("ROBOT_API_URL", None)
_LAST_SSM_FETCH_TIME = 0

def get_robot_api_url():
    """Dynamically fetch the Robot API URL from environment or SSM with caching"""
    global _ROBOT_API_URL, _LAST_SSM_FETCH_TIME
    
    if _ROBOT_API_URL:
        return _ROBOT_API_URL

    now = time.time()
    if now - _LAST_SSM_FETCH_TIME < 60:
        return None
    
    _LAST_SSM_FETCH_TIME = now

    try:
        ssm = boto3.client("ssm")
        param_name = "/robotics/robot_api_url"
        logger.info(f"🔍 ROBOT_API_URL not set. Attempting lookup from SSM: {param_name}")
        
        response = ssm.get_parameter(Name=param_name)
        _ROBOT_API_URL = response["Parameter"]["Value"]
        
        logger.info(f"✅ Discovered API URL via SSM: {_ROBOT_API_URL}")
        return _ROBOT_API_URL
    except Exception as e:
        logger.error(f"❌ Failed to fetch ROBOT_API_URL from SSM: {e}")
        return None

SESSION_AES_KEY = os.environ.get("SESSION_AES_KEY", "0123456789012345").encode()
SESSION_AES_IV = os.environ.get("SESSION_AES_IV", "5432109876543210").encode()

# Mapping from simulator standard actions to real hardware action names
REAL_ROBOT_ACTION_MAP = {
    "dance": "robot_dance",
    "wave": "robot_wave",
    "bow": "robot_bow",
    "kung_fu": "robot_kung_fu",
    "kick": "robot_kick",
    "punch": "robot_punch",
    "jump": "robot_jump",
    "push_ups": "robot_push_ups",
    "sit_ups": "robot_sit_ups",
    "jumping_jacks": "robot_jumping_jacks",
    "celebrate": "robot_celebrate",
    "think": "robot_think",
    "twist": "robot_twist",
    "right_uppercut": "robot_right_uppercut",
    "left_uppercut": "robot_left_uppercut",
    "right_shot_fast": "robot_right_shot_fast",
    "left_shot_fast": "robot_left_shot_fast",
    "chest": "robot_chest",
    "weightlifting": "robot_weightlifting"
}

def send_request(method: str, robot_id: str, action: str) -> Optional[Dict[str, Any]]:
    """Send request to external robot API with action mapping for hardware compatibility"""
    api_url = get_robot_api_url()
    if not api_url:
        logger.warning("❌ ROBOT_API_URL is NOT set and SSM lookup failed. Cannot call real robot.")
        return None

    # Map the action to a standard hardware-supported action if necessary
    hardware_action = REAL_ROBOT_ACTION_MAP.get(action, action)
    if not hardware_action.startswith("robot_"):
        hardware_action = f"robot_{hardware_action}"
    
    target_url = f"{api_url.rstrip('/')}/{robot_id.lstrip('/')}"
    data = {"method": method, "action": hardware_action}
    
    internal_secret = os.getenv("INTERNAL_ROBOT_SECRET", "")
    if not internal_secret:
        logger.error("❌ INTERNAL_ROBOT_SECRET is not configured. Cannot call real robot.")
        return None
    headers = {
        "X-Internal-Secret": internal_secret,
        "Content-Type": "application/json"
    }
    
    logger.info(f"🚀 CALLING REAL ROBOT (INTERNAL): {target_url} with data: {data} (Original: {action})")
    
    try:
        response = requests.post(
            target_url,
            json=data,
            headers=headers,
            timeout=5,
        )
        logger.info(f"📥 API RESPONSE [{response.status_code}]: {response.text}")
        response.raise_for_status()
        return response.json()
    except requests.RequestException as e:
        logger.error(f"❌ Error sending request to {target_url}: {e}")
        return None


def decrypt(session_key: str) -> Optional[dict]:
    """
    Decrypts an AES encrypted string using a fixed key and IV.
    """
    try:
        session_key = unquote_plus(session_key).replace(" ", "+")
        encrypted_bytes = base64.b64decode(session_key)

        cipher = Cipher(
            algorithms.AES(SESSION_AES_KEY),
            modes.CBC(SESSION_AES_IV),
            backend=default_backend(),
        )
        decryptor = cipher.decryptor()
        decrypted_bytes = decryptor.update(encrypted_bytes) + decryptor.finalize()

        unpadder = padding.PKCS7(algorithms.AES.block_size).unpadder()
        decrypted_bytes = unpadder.update(decrypted_bytes) + unpadder.finalize()

        decrypted_string = decrypted_bytes.decode("utf-8")
        logger.info(f"Decrypted string: {decrypted_string}")

        if decrypted_string.endswith('"'):
            decrypted_string = decrypted_string[:-1]

        try:
            session_object = json.loads(decrypted_string)
        except json.JSONDecodeError as json_error:
            logger.error(f"JSON parsing error: {json_error}")
            return None

        # Convert Excel serial dates to datetime and check validity
        excel_start_date = datetime(1899, 12, 30, tzinfo=ZoneInfo("Asia/Hong_Kong"))
        decoded_datetime_to = decoded_datetime_from = None

        if "to" in session_object:
            decoded_datetime_to = excel_start_date + timedelta(
                days=session_object["to"]
            )
            session_object["to"] = decoded_datetime_to

        if "from" in session_object:
            decoded_datetime_from = excel_start_date + timedelta(
                days=session_object["from"]
            )
            session_object["from"] = decoded_datetime_from

        current_time = datetime.now(ZoneInfo("Asia/Hong_Kong"))
        session_object["is_valid"] = (
            decoded_datetime_from is not None
            and decoded_datetime_to is not None
            and decoded_datetime_from < current_time < decoded_datetime_to
        )
        logger.info(f"Session object after decryption: {session_object}")
        return session_object

    except Exception as e:
        logger.info(f"Decryption failed: {e}")
        return None
