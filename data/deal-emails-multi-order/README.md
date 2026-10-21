# One email, several orders (fictional samples)

Two invented notices for the 1:N case in `docs/deal-pipeline-design.md` §15. Every issuer, bank,
person and number is made up.

| Sample | Shape | Orders the parser should stage |
| --- | --- | --- |
| `m1-…-bluehaven-media-…` | one notice, one security in five tranches across two currencies | USD 5yr, USD 8yr, USD 10yr, EUR 5yr, EUR 8yr — EUR sizes TBD, EUR talk stated as "+100bps from USD" |
| `m2-…-oakline-home-services-…` | a forwarded thread carrying a loan launch and a bond launch for one issuer | First Lien TLB, Delayed Draw TLB, Senior Secured Notes — loan and bond differ in Pipeline Type, left lead, tenor, call protection and pricing basis |

They live here rather than in `data/deal-emails/` on purpose: the Simulate dialog and the S3 sample
seed read only that directory, and today's parser stages one deal per email, so offering these would
stage one order and drop the rest. Move them into `data/deal-emails/` when the parser stages orders.
