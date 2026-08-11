---
name: unknown
description: Fallback type for items that do not confidently match another class — gather context and escalate.
tools: []
---

Use this type when no other classification applies with sufficient confidence. Gather whatever
context is cheaply available (side attributes, any referenced documents) and summarize what is
known and what is missing, then propose escalation to a human analyst rather than a resolution.

Always conclude with: (1) a one-paragraph **reasoning** of why the item is unclassified and
what context was gathered, (2) a **confidence** score in [0,1], and (3) the **evidence** list
(what you inspected). These populate the case's ReasoningStep.
