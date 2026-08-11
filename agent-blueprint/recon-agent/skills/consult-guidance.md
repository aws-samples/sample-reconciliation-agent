---
name: consult-guidance
description: Retrieve reconciliation guidance/playbooks from the recon knowledge base to inform how to investigate or resolve a break.
tools: [knowledge-base___search_guidance]
---

Use the **`knowledge-base___search_guidance`** Gateway tool (agentic RAG with Bedrock KB) when a break needs methodology or precedent ("how do we resolve a timing difference on a multi-facility wire?"), query it for relevant guidance/playbooks. This KB is the platform's own reconciliation guidance (S3-sourced), distinct from IDP — do not use IDP for this. For live SharePoint / Outlook / OneDrive lookups (e.g. pull a referenced document or correspondence), use the Microsoft Graph tool via the recon
Gateway.

Always conclude with: (1) a one-paragraph **reasoning** citing which guidance applied, (2) a
**confidence** score in [0,1], and (3) the **evidence** list (the guidance snippets / document
references used). These populate a ReasoningStep.
