import os
import json
import logging

logger = logging.getLogger()

def auth_handler(event, context):
    """Custom API Gateway Authorizer for WebSocket $connect."""
    logger.info(f"Custom Authorizer event: {json.dumps(event)}")
    method_arn = event.get("methodArn", "")
    
    # Extract token from query parameters or Authorization header
    q_params = event.get("queryStringParameters", {}) or {}
    token = q_params.get("token")
    
    if not token:
        headers = event.get("headers", {}) or {}
        auth_header = headers.get("Authorization", "") or headers.get("authorization", "")
        if auth_header.lower().startswith("bearer "):
            token = auth_header[7:]
            
    if not token:
        logger.warning("No token found in query string or headers.")
        return generate_iam_policy("unauthorized", "Deny", method_arn)
        
    try:
        import jwt
        import requests
        
        user_pool_id = os.environ.get("COGNITO_USER_POOL_ID")
        region = os.environ.get("COGNITO_REGION")
        client_id = os.environ.get("COGNITO_USER_POOL_CLIENT_ID")
        
        if not user_pool_id or not region:
            logger.error("COGNITO_USER_POOL_ID or COGNITO_REGION env variables are not defined!")
            return generate_iam_policy("unauthorized", "Deny", method_arn)
            
        jwks_url = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}/.well-known/jwks.json"
        
        # Simple fetch with a short timeout
        jwks = requests.get(jwks_url, timeout=5.0).json()
        
        # Decode token header to get kid
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")
        
        # Locate public key from JWKS
        public_key = None
        for key in jwks.get("keys", []):
            if key.get("kid") == kid:
                from jwt.algorithms import RSAAlgorithm
                public_key = RSAAlgorithm.from_jwk(key)
                break
                
        if not public_key:
            raise ValueError("Matching public key not found in JWKS.")
            
        # Verify token signature, expiry, issuer and audience
        decoded = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}"
        )
        
        principal_id = decoded.get("sub", "authorized-user")
        logger.info(f"Custom Authorizer validation succeeded for user: {principal_id}")
        return generate_iam_policy(principal_id, "Allow", method_arn)
        
    except Exception as e:
        logger.error(f"Custom Authorizer token validation failed: {e}")
        return generate_iam_policy("unauthorized", "Deny", method_arn)


def generate_iam_policy(principal_id, effect, method_arn):
    """Generates standard API Gateway Authorizer Response Policy Document."""
    return {
        "principalId": principal_id,
        "policyDocument": {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Action": "execute-api:Invoke",
                    "Effect": effect,
                    "Resource": method_arn
                }
            ]
        }
    }
