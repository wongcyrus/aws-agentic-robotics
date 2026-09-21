#!/usr/bin/env python3
"""
DynamoDB RobotTable Backup and Restore Script
Allows backing up all records of a DynamoDB table to a local JSON file, and restoring them.
"""

import argparse
import decimal
import json
import os
import sys
import boto3
from botocore.exceptions import ClientError

from cdk_outputs import get_stack_output

DEFAULT_FILE = "robot_table_backup.json"


class DecimalEncoder(json.JSONEncoder):
    """Custom JSON encoder to handle DynamoDB Decimal types gracefully"""
    def default(self, o):
        if isinstance(o, decimal.Decimal):
            if o % 1 == 0:
                return int(o)
            return float(o)
        return super(DecimalEncoder, self).default(o)


def get_dynamodb_resource():
    """Initialize boto3 DynamoDB resource with proper region"""
    region_name = os.getenv("AWS_DEFAULT_REGION") or os.getenv("AWS_REGION") or "us-east-1"
    return boto3.resource("dynamodb", region_name=region_name)


def backup_table(table_name, file_path):
    """Backup all records of the DynamoDB table to a local JSON file"""
    print(f"Starting backup of table '{table_name}' to '{file_path}'...")
    dynamodb = get_dynamodb_resource()
    table = dynamodb.Table(table_name)

    try:
        items = []
        response = table.scan()
        items.extend(response.get("Items", []))

        # Handle pagination if table is larger than 1MB
        while "LastEvaluatedKey" in response:
            response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
            items.extend(response.get("Items", []))

        print(f"Successfully retrieved {len(items)} records from DynamoDB.")

        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(items, f, cls=DecimalEncoder, indent=2, ensure_ascii=False)

        print(f"Backup complete! {len(items)} records saved to '{file_path}'.")
        return True

    except ClientError as e:
        print(f"Error communicating with DynamoDB: {e}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"An unexpected error occurred during backup: {e}", file=sys.stderr)
        return False


def restore_table(table_name, file_path):
    """Restore records from a local JSON file into the DynamoDB table"""
    if not os.path.exists(file_path):
        print(f"Error: Backup file '{file_path}' does not exist.", file=sys.stderr)
        return False

    print(f"Starting restore to table '{table_name}' from '{file_path}'...")
    
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            items = json.load(f, parse_float=decimal.Decimal, parse_int=decimal.Decimal)

        if not items:
            print("Warning: Backup file is empty, nothing to restore.")
            return True

        dynamodb = get_dynamodb_resource()
        table = dynamodb.Table(table_name)

        print(f"Loaded {len(items)} records from backup file. Writing to DynamoDB...")

        # Write in batches using batch_writer for maximum efficiency
        count = 0
        with table.batch_writer() as batch:
            for item in items:
                # Ensure the item has 'id' field
                if "id" not in item:
                    print(f"Skipping invalid record lacking 'id' attribute: {item}", file=sys.stderr)
                    continue
                batch.put_item(Item=item)
                count += 1

        print(f"Restore complete! Successfully wrote {count} records to table '{table_name}'.")
        return True

    except json.JSONDecodeError as e:
        print(f"Error parsing backup JSON file: {e}", file=sys.stderr)
        return False
    except ClientError as e:
        print(f"Error communicating with DynamoDB: {e}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"An unexpected error occurred during restore: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(
        description="DynamoDB Table Backup & Restore Utility",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Backup to default file (robot_table_backup.json):
  python3 backup_restore.py backup

  # Backup to custom file:
  python3 backup_restore.py backup --file custom_backup.json

  # Restore from custom file to a custom table:
  python3 backup_restore.py restore --table MyCustomRobotTable --file custom_backup.json
        """
    )
    
    parser.add_argument(
        "action",
        choices=["backup", "restore"],
        help="Action to perform: 'backup' or 'restore'"
    )
    parser.add_argument(
        "--table",
        help="Target DynamoDB table name (default: RobotTable from cdk/output.json)"
    )
    parser.add_argument(
        "--file",
        default=DEFAULT_FILE,
        help=f"Local JSON file path for backup/restore (default: {DEFAULT_FILE})"
    )

    args = parser.parse_args()

    table_name = args.table or get_stack_output("RobotTable")

    if args.action == "backup":
        success = backup_table(table_name, args.file)
    else:
        success = restore_table(table_name, args.file)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
