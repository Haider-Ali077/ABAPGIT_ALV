# ABAPGIT_ALV

SAP S/4HANA ALV reports managed with [abapGit](https://abapgit.org).

## Reports

### `ZMM_LANDED_COST` – Landed Cost Report

Shows the landed cost for each purchase order or scheduling agreement item. Landed cost is the material value plus all delivery costs posted against the item.

| Column | Source |
|---|---|
| Material value, received qty | `EKBE` (PO history), signed by `SHKZG` |
| Freight / Customs / Insurance / Other | `EKBZ` (delivery cost history), bucketed by condition type `KSCHL` |
| Landed cost | Material value + total delivery costs |
| Landed cost per unit | Landed cost / received qty (order unit) |
| Delivery cost % | Total delivery costs / material value × 100 |

Amounts are in company code currency.

**Selection screen**

- *Purchasing Data*: company code (required), plant, PO, vendor, material, document date.
- *Cost Basis*:
  - **Goods receipt (accrued)** uses GR history (`VGABE = 1`).
  - **Invoice receipt (actual)** uses IR history (`VGABE = 2`).
  - *Include items w/o history* also lists items with no postings yet.
- *Delivery Cost Condition Types*: which condition types count as Freight, Customs and Insurance. The defaults are `FRA1/FRB1/FRC1` for freight and `ZOA1/ZOB1/ZOC1` for customs. Change them to match your pricing procedure. Any condition type not listed is reported as *Other*.

**ALV output**

- Subtotals per company code and plant, plus a grand total.
- Click a PO number to open ME23N, or a material to open MM03.
- Users can save layout variants.

## Installation

1. In the SAP system, run transaction `ZABAPGIT` (or the abapGit report).
2. Choose **New Online**, enter this repository URL and a target package (e.g. `$ZALV` or a transportable `Z` package).
3. Pull and activate.
