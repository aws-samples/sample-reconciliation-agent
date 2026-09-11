"""Small DynamoDB and clock helpers shared by the two Lambda handlers.

Both handlers update records whose attribute names collide with DynamoDB reserved words
(``status``, ``error``); aliasing every name through ``ExpressionAttributeNames`` in one place
means neither handler has to remember which ones.
"""

from datetime import UTC, datetime


def utc_now_iso() -> str:
    """Current UTC time as an ISO-8601 string with second precision and a ``Z`` suffix."""
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def update_attributes(
    table, key: dict, values: dict, *, append: dict | None = None, expect: dict | None = None
) -> None:
    """``SET`` each attribute in ``values`` and ``list_append`` each list in ``append`` on one item.

    :param table: boto3 DynamoDB ``Table`` resource.
    :param key: the item's primary key.
    :param values: attribute name -> new value (None stores a NULL).
    :param append: attribute name -> list of elements to append (the attribute is created when
        missing, so a record written before the list existed still accepts history).
    :param expect: attribute name -> value the item must currently hold, as a
        ``ConditionExpression``. A mismatch raises botocore's ``ConditionalCheckFailedException``
        (see :func:`is_conditional_check_failed`) and writes nothing, so a status transition
        cannot clobber one that won a race.
    """
    names, exprs, params = {}, [], {}
    for index, (name, value) in enumerate(values.items()):
        names[f"#a{index}"] = name
        exprs.append(f"#a{index} = :v{index}")
        params[f":v{index}"] = value
    for index, (name, items) in enumerate((append or {}).items()):
        names[f"#l{index}"] = name
        exprs.append(f"#l{index} = list_append(if_not_exists(#l{index}, :empty), :l{index})")
        params[f":l{index}"] = list(items)
    if append:
        params[":empty"] = []
    kwargs = {
        "Key": key,
        "UpdateExpression": "SET " + ", ".join(exprs),
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": params,
    }
    if expect:
        conditions = []
        for index, (name, value) in enumerate(expect.items()):
            names[f"#c{index}"] = name
            params[f":c{index}"] = value
            conditions.append(f"#c{index} = :c{index}")
        kwargs["ConditionExpression"] = " AND ".join(conditions)
    table.update_item(**kwargs)


def is_conditional_check_failed(err: Exception) -> bool:
    """True when ``err`` is DynamoDB's answer to a failed ``ConditionExpression``."""
    code = (
        getattr(err, "response", {}).get("Error", {}).get("Code")
        if hasattr(err, "response")
        else None
    )
    return code == "ConditionalCheckFailedException"
