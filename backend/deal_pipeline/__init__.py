"""Deal pipeline backend: parsing agent and mock OMS for new-issue deal emails.

The package turns a deal email (a market news alert or an arranger's launch notice) into one
OMS staging CSV, and then plays the part of the OMS that receives it. Design contract:
``docs/deal-pipeline-design.md``.

Modules, in the order a deal flows through them:

- ``oms_schema``       the OMS field schema (``oms_fields.json``), value validation, CSV in/out.
                       Mirrored by the frontend's ``omsSchema.ts``; a test pins the two together.
- ``coerce``           pure text-to-OMS-format helpers (bps to percent, "$1.75bn" to millions,
                       "Aug. 13" to ``M/D/YYYY`` ...) the agent applies to model output.
- ``security_master``  fictional issuer / counterparty reference data and matching.
- ``memory_recall``    fail-soft recall of edge-case rules from AgentCore Memory.
- ``skills_loader``    SKILL.md catalog from S3 with a dependency-free frontmatter parser.
- ``agent``            the Bedrock Converse tool-use loop that produces a ``ParseOutput``.
- ``parser_handler``   Lambda entry point: email record in, deal record + staging CSV out.
- ``oms_validator``    the mock OMS rule set (design section 6) with stable error codes.
- ``oms_upload_handler`` Lambda entry point: staging CSV in, ``UploadResult`` out.

Shared plumbing comes from ``backend.recon_core``: ``memory.retrieve_records`` (behind
``memory_recall``), ``model_select.get_agent_model_id``, ``ddb_update`` (the ``UpdateItem``
helpers and ``utc_now_iso``) and ``s3_text.read_text``. Every one of those imports boto3 and the
standard library only, which is all this package's Lambda zip vendors (plus ``tzdata``); nothing
here may import ``recon_core.ddb`` or ``recon_core.schema``, which need pydantic.
"""
