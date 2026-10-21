"""moto-backed DynamoDB tables in the shape the handlers expect."""

import boto3

REGION = "us-east-1"


def make_table(name: str, hash_key: str, *, range_key: str | None = None, gsis=()):
    """Create a PAY_PER_REQUEST table (inside an active ``mock_aws``) and return its ``Table``.

    Every key attribute is a string. ``gsis`` is a sequence of ``(index_name, hash_key)`` or
    ``(index_name, hash_key, range_key)`` tuples; each index projects ALL attributes, as the
    Terraform modules declare them.
    """
    key_schema = [{"AttributeName": hash_key, "KeyType": "HASH"}]
    attributes = {hash_key}
    if range_key:
        key_schema.append({"AttributeName": range_key, "KeyType": "RANGE"})
        attributes.add(range_key)
    indexes = []
    for index_name, index_hash, *rest in gsis:
        schema = [{"AttributeName": index_hash, "KeyType": "HASH"}]
        attributes.add(index_hash)
        if rest and rest[0]:
            schema.append({"AttributeName": rest[0], "KeyType": "RANGE"})
            attributes.add(rest[0])
        indexes.append(
            {"IndexName": index_name, "KeySchema": schema, "Projection": {"ProjectionType": "ALL"}}
        )
    kwargs = {
        "TableName": name,
        "KeySchema": key_schema,
        "AttributeDefinitions": [
            {"AttributeName": a, "AttributeType": "S"} for a in sorted(attributes)
        ],
        "BillingMode": "PAY_PER_REQUEST",
    }
    if indexes:
        kwargs["GlobalSecondaryIndexes"] = indexes
    return boto3.resource("dynamodb", region_name=REGION).create_table(**kwargs)
