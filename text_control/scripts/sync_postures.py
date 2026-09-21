import urllib.request
import json
import os
import boto3

from cdk_outputs import PROJECT_ROOT, get_stack_output

def load_subscription_key():
    # Try reading from environment
    key = os.environ.get("XIAOICE_SUBSCRIPTION_KEY")
    if key:
        return key
    
    # Try reading from cdk/.env
    possible_paths = [
        PROJECT_ROOT / "cdk" / ".env",
        "cdk/.env",
    ]
    for p in possible_paths:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip().startswith("XIAOICE_SUBSCRIPTION_KEY="):
                        return line.split("=", 1)[1].strip()
    return None

def sync_postures():
    table_name = get_stack_output("RobotTable")
    subscription_key = load_subscription_key()
    if not subscription_key:
        print("Error: XIAOICE_SUBSCRIPTION_KEY not found in env or cdk/.env")
        return

    # 1. Generate signature
    gen_url = "https://interactive-virtualhuman.xiaoice.com/openapi/signature/gen"
    print(f"Generating signature from {gen_url}...")
    req = urllib.request.Request(gen_url, method="GET")
    req.add_header("subscription-key", subscription_key)
    
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            status = response.status
            body = response.read().decode('utf-8', errors='ignore')
            if status == 200:
                data = json.loads(body)
                if data.get("code") == 200 and data.get("data"):
                    sign_token = data.get("data")
                    print("Signature successfully generated!")
                else:
                    print("Failed to get signature from data")
                    return
            else:
                print("Non-200 response for signature")
                return
    except Exception as e:
        print(f"Error fetching signature: {e}")
        return

    # List of our active avatars (Midnight and Ice have renamed IDs!)
    avatars_to_query = {
        "Alita": "VHPGWXRFDO5SGXS",
        "Claire": "VHPG5IBBOCINANM",
        "Summer": "VHPP6MVJSV72RD3",
        "Midnight": "VHPP5QFZM6TZWQ9",
        "Ice": "VHPRGB4TU11ZVYJ"
    }

    dynamodb = boto3.resource("dynamodb")
    table = dynamodb.Table(table_name)

    for name, biz_id in avatars_to_query.items():
        try:
            url = f"https://interactive-virtualhuman.xiaoice.com/openapi/talk/queryInteractiveVirtualHuman/byBizId/v2?bizId={biz_id}"
            print(f"Querying Details for {name} ({biz_id})...")
            
            details_req = urllib.request.Request(url, method="GET")
            details_req.add_header("signature", sign_token)
            
            with urllib.request.urlopen(details_req, timeout=10) as response:
                body = response.read().decode('utf-8')
                parsed = json.loads(body)
                print(f"--- RAW DATA FOR {name} ---")
                print(json.dumps(parsed, indent=2, ensure_ascii=False))
                if parsed.get("code") == 200 and parsed.get("data"):
                    data = parsed["data"]
                    vh_mode_info = data.get("virtualHumanModeInfo") or {}
                    postures = vh_mode_info.get("virtualHumanPostureInfo") or []
                    print(f"Successfully retrieved {len(postures)} postures for {name}!")
                    
                    db_postures = []
                    for p in postures:
                        db_postures.append({
                            "chineseName": p.get("chineseName"),
                            "englishName": p.get("englishName"),
                            "virtualHumanPostureId": p.get("virtualHumanPostureId")
                        })
                    
                    # Update the DynamoDB item with available_postures
                    # First check if the item exists
                    res = table.get_item(Key={"id": name})
                    if "Item" in res:
                        table.update_item(
                            Key={"id": name},
                            UpdateExpression="SET available_postures = :ap",
                            ExpressionAttributeValues={":ap": db_postures}
                        )
                        print(f"Updated DynamoDB item '{name}' with {len(db_postures)} postures.")
                    else:
                        print(f"Warning: Item with id '{name}' not found in RobotTable. Skipping DB update.")
                else:
                    print(f"Error for {name}: {parsed}")
        except Exception as e:
            print(f"Exception for {name}: {e}")

if __name__ == "__main__":
    sync_postures()
