# FSD — Landed Cost Report (ZMM_LANDED_COST)

> Reverse-engineered from `src/zmm_landed_cost.prog.abap`, `src/zmm_landed_cost.prog.xml` and `README.md` (commit `fdabad0`).
> This document is also the **FSD template sample** for SuperNova: every `##` section below is a required template section, and the guidance in *italics* under each heading is what the FSD Generator Agent must fill.
> Items tagged **[A-n]** are assumptions. The reference code does not prove them; they are inferred.

---

## 0. Document control

*Fixed metadata. Filled by the platform, not the LLM.*

| Field | Value |
|---|---|
| FSD ID | FSD-REQ-0001 |
| Requirement | REQ-0001 "Landed cost per PO item" |
| Version | 1.0 (reverse-engineered) |
| Module / area | MM — Purchasing / Logistics Invoice Verification |
| Object type | Executable report (PROG, SUBC = 1) with ALV output |
| Proposed object name | `ZMM_LANDED_COST` |
| Target release | SAP S/4HANA on-premise **[A-1]** (README says "SAP S/4HANA"; code uses 7.40+ syntax: inline `DATA(...)`, `VALUE #`, `COND #`, `@` host variables) |
| Author | Functional Consultant |
| Approver | Functional Approver |
| Status | Approved (reference) |

## 1. Purpose and business background

*Why the report exists, who asked, which decision it supports. 3–6 sentences, no technical detail.*

Purchasing and controlling need to see the **real (landed) cost** of purchased materials, not just the PO net price. Landed cost = material value + delivery costs posted against the item (freight, customs/duty, insurance, other). The report shows this per PO / scheduling agreement item, per unit, and as a percentage of material value, so buyers can compare vendors and incoterms, and controlling can check delivery-cost accruals against actual invoices.

Two views are needed:
- **Accrued** — based on goods receipts (what was accrued when the goods arrived).
- **Actual** — based on invoice receipts (what was really invoiced).

## 2. Scope

*Explicit IN / OUT so the Dev Agent does not invent features.*

**In scope**
- Purchase orders (`BSTYP = 'F'`) and scheduling agreements (`BSTYP = 'L'`).
- Planned delivery costs recorded in PO delivery-cost history (EKBZ).
- Amounts in company-code currency.
- ALV grid output with totals, subtotals, drill-down, layout variants.

**Out of scope**
- Contracts, RFQs (other `BSTYP`).
- Unplanned delivery costs entered in MIRO (they are not written to EKBZ) **[A-2]**.
- Subsequent debits/credits (`VGABE = '3'`) **[A-3]** — the code reads only `VGABE` 1 or 2. See open question Q-3.
- Document/PO currency view.
- Background output to spool other than standard ALV list.

## 3. Users, frequency, volume

*Who runs it, how often, expected data volume (drives performance design).*

| Item | Value |
|---|---|
| Users | Buyers, purchasing managers, plant controllers **[A-4]** |
| Frequency | On demand; monthly at period close **[A-4]** |
| Volume | Up to tens of thousands of PO items per run **[A-5]** (design uses `FOR ALL ENTRIES` + sorted tables, which is fine for this order of magnitude) |
| Execution | Dialog (foreground). Background allowed via standard ALV. |

## 4. Selection screen

*One row per field. Technical reference must exist in the SAP metadata catalog. Every field needs a human label (lesson from commit `fdabad0`: labels must not depend on text elements).*

**Block B1 — "Purchasing Data"**

| Field | Label | Reference | Kind | Mandatory | Default |
|---|---|---|---|---|---|
| `S_BUKRS` | Company Code | `EKKO-BUKRS` | Select-option | **Yes** | — |
| `S_WERKS` | Plant | `EKPO-WERKS` | Select-option | No | — |
| `S_EBELN` | Purchase Order | `EKKO-EBELN` | Select-option | No | — |
| `S_LIFNR` | Vendor | `EKKO-LIFNR` | Select-option | No | — |
| `S_MATNR` | Material | `EKPO-MATNR` | Select-option | No | — |
| `S_BEDAT` | PO Document Date | `EKKO-BEDAT` | Select-option | No | — |

**Block B2 — "Cost Basis"**

| Field | Label | Kind | Default |
|---|---|---|---|
| `P_GR` | Goods Receipt (Accrued Cost) | Radio button, group `BAS` | **X** |
| `P_IR` | Invoice Receipt (Actual Cost) | Radio button, group `BAS` | — |
| `P_OPEN` | Include Items without GR / IR | Checkbox | blank |

**Block B3 — "Delivery Cost Condition Types"**

| Field | Label | Reference | Kind | Default |
|---|---|---|---|---|
| `S_KFRT` | Freight Condition Types | `EKBZ-KSCHL` | Select-option, NO INTERVALS | `FRA1`, `FRB1`, `FRC1` |
| `S_KCUS` | Customs / Duty Condition Types | `EKBZ-KSCHL` | Select-option, NO INTERVALS | `ZOA1`, `ZOB1`, `ZOC1` |
| `S_KINS` | Insurance Condition Types | `EKBZ-KSCHL` | Select-option, NO INTERVALS | — (customer-specific) |

Defaults are the standard MM pricing procedure delivery-cost conditions; the customer must align them with its own pricing procedure.

## 5. Data sources

*Every table and field used. The Data Analysis Agent produces this; the Validation Agent checks each entry against the catalog.*

| Table | Description | Used for | Join / key |
|---|---|---|---|
| `EKKO` | Purchasing document header | BUKRS, EBELN, BEDAT, LIFNR, BSTYP filter | — |
| `EKPO` | Purchasing document item | WERKS, EBELP, MATNR, TXZ01, MENGE (PO qty), MEINS, LOEKZ filter | `EKPO-EBELN = EKKO-EBELN` |
| `T001` | Company codes | WAERS (company-code currency) | `T001-BUKRS = EKKO-BUKRS` (inner join) |
| `LFA1` | Vendor master (general) | NAME1 | `LFA1-LIFNR = EKKO-LIFNR` (left outer) |
| `EKBE` | PO history | MENGE, DMBTR, SHKZG by VGABE | `EBELN, EBELP` + `VGABE`; full key `ZEKKN, VGABE, GJAHR, BELNR, BUZEI` selected |
| `EKBZ` | PO history — delivery costs | DMBTR, SHKZG, KSCHL by VGABE | `EBELN, EBELP` + `VGABE`; full key `STUNR, ZAEHK, VGABE, GJAHR, BELNR, BUZEI` selected |

## 6. Business logic

*Numbered functional requirements (FR-nn). Each FR must be testable and traceable to code. This is what the Validation Agent checks coverage against.*

| ID | Rule |
|---|---|
| **FR-01** | Select items of purchasing documents with `BSTYP IN ('F','L')` matching the selection screen; exclude deleted items (`EKPO-LOEKZ = 'L'`). |
| **FR-02** | Cost basis: `P_GR` → `VGABE = '1'`; `P_IR` → `VGABE = '2'`. The same VGABE applies to both EKBE and EKBZ. |
| **FR-03** | Received/invoiced quantity = Σ `EKBE-MENGE`; material value = Σ `EKBE-DMBTR`, for the item and VGABE. Rows with `SHKZG = 'H'` (reversals, credit memos) are subtracted. |
| **FR-04** | Delivery cost amount per EKBZ row = `DMBTR`, negated when `SHKZG = 'H'`. Bucket by `KSCHL`: in `S_KFRT` → Freight; else in `S_KCUS` → Customs; else in `S_KINS` → Insurance; else → Other. An **empty** list matches nothing (it must not act as "all"). Precedence if a condition type is in several lists: Freight > Customs > Insurance. |
| **FR-05** | Total delivery costs = Freight + Customs + Insurance + Other. Landed cost = material value + total delivery costs. |
| **FR-06** | Landed cost per unit = landed cost / received quantity; 0 when received quantity = 0. |
| **FR-07** | Delivery cost % = total delivery costs / material value × 100; 0 when material value = 0. |
| **FR-08** | Unless `P_OPEN` is set, drop items where received qty, material value and total delivery costs are all 0. |
| **FR-09** | Amounts are in company-code currency (`EKBE/EKBZ-DMBTR`, currency `T001-WAERS`). Quantities are in order unit (`EKPO-MEINS`). |
| **FR-10** | Default sort: BUKRS ↑ (subtotal), WERKS ↑ (subtotal), EBELN ↑, EBELP ↑. Grand total and subtotals on all amount columns except landed cost per unit and DC %. |
| **FR-11** | Hotspot on PO number → `ME23N` (parameter ID `BES`); hotspot on material → `MM03` (parameter ID `MAT`, skip first screen). Both with authority check of the called transaction. No hotspot action when material is empty (text items). |
| **FR-12** | Users can save user-specific and global layout variants and mark one as default. |
| **FR-13** | List header: "Landed Cost Report - Goods Receipt (Accrued)" or "... - Invoice Receipt (Actual)" depending on basis. |
| **FR-14** | If nothing is selected, show "No purchase order items found for the given selection" as a status message displayed like an error and stay on the selection screen. |

## 7. Output layout

*One row per column: technical name, heading, source/formula, reference field, aggregation.*

| # | Column | Heading (long) | Source / formula | Ref. | Total |
|---|---|---|---|---|---|
| 1 | BUKRS | Company Code | EKKO-BUKRS | | sort + subtotal |
| 2 | WERKS | Plant | EKPO-WERKS | | sort + subtotal |
| 3 | EBELN | Purchasing Document | EKPO-EBELN (hotspot) | | sort |
| 4 | EBELP | Item | EKPO-EBELP | | sort |
| 5 | BEDAT | Document Date | EKKO-BEDAT | | |
| 6 | LIFNR | Vendor | EKKO-LIFNR | | |
| 7 | NAME1 | Vendor Name | LFA1-NAME1 | | |
| 8 | MATNR | Material | EKPO-MATNR (hotspot) | | |
| 9 | TXZ01 | Short Text | EKPO-TXZ01 | | |
| 10 | PO_QTY | PO Quantity | EKPO-MENGE | MEINS | |
| 11 | RCV_QTY | Received / Invoiced Quantity | FR-03 | MEINS | |
| 12 | MEINS | Order Unit | EKPO-MEINS | | |
| 13 | HWAER | Company Code Currency | T001-WAERS | | |
| 14 | MAT_VALUE | Material Value | FR-03 | HWAER | Σ |
| 15 | FREIGHT | Freight | FR-04 | HWAER | Σ |
| 16 | CUSTOMS | Customs / Duty | FR-04 | HWAER | Σ |
| 17 | INSURANCE | Insurance | FR-04 | HWAER | Σ |
| 18 | OTHER_DC | Other Delivery Costs | FR-04 | HWAER | Σ |
| 19 | TOTAL_DC | Total Delivery Costs | FR-05 | HWAER | Σ |
| 20 | LANDED | Landed Cost | FR-05 | HWAER | Σ |
| 21 | UNIT_LC | Landed Cost per Unit | FR-06 | HWAER | — |
| 22 | DC_PCT | Delivery Cost % of Material Value | FR-07 | | — |

Display: striped rows, optimized column width, all standard ALV functions (sort, filter, export).

## 8. Interactive features

*Drill-downs, variants, buttons.* — see FR-10, FR-11, FR-12. No custom toolbar buttons.

## 9. Messages and error handling

| Situation | Behaviour |
|---|---|
| No data | FR-14 |
| ALV framework exception (`CX_SALV_MSG`, `CX_SALV_NOT_FOUND`, `CX_SALV_EXISTING`, `CX_SALV_DATA_ERROR`) | Error message with exception text |
| Division by zero | Prevented by FR-06 / FR-07 guards |

## 10. Authorizations

*Which authorization objects protect the data. The reference report is weak here — see Q-2.*

| Check | In reference? |
|---|---|
| Called transactions ME23N / MM03 (`CALL TRANSACTION ... WITH AUTHORITY-CHECK`) | Yes |
| Purchasing data display: `M_BEST_EKO` / `M_BEST_EKG` / `M_BEST_WRK` / `M_BEST_BSA` (activity 03); for scheduling agreements `M_RAHM_*` | **No** |
| Report start (S_PROGRAM / transaction code with auth group) | **No** (no Z-transaction in the repo) |

## 11. Performance

- One join for header/item/company code/vendor; history tables read with `FOR ALL ENTRIES`, guarded by a non-empty driver table.
- The full EKBE / EKBZ key is selected so `FOR ALL ENTRIES` (which removes duplicate rows) does not drop identical postings.
- History held in `SORTED` tables keyed by `EBELN, EBELP` so the nested `LOOP ... WHERE` uses the key.
- Only `S_BUKRS` is mandatory → a run on a big company code without date restriction can be slow **[A-5]**.

## 12. Technical notes (handed to Tech Architect)

| Item | Value |
|---|---|
| Objects | 1 × PROG `ZMM_LANDED_COST` (executable, fixed-point arithmetic, Unicode checks). No DDIC objects, no transaction code. |
| ALV | `CL_SALV_TABLE` with local event class `LCL_EVENTS` for `LINK_CLICK` |
| Delivery format | abapGit repo, `FOLDER_LOGIC = PREFIX`, `STARTING_FOLDER = /src/`, master language E |
| Labels | Selection labels and block titles assigned in `INITIALIZATION` (works even when pasted into SE38 without text pool); selection texts also in text pool |

## 13. Assumptions

- **[A-1]** Target is S/4HANA on-premise, ABAP 7.50 or later.
- **[A-2]** Unplanned delivery costs are not in EKBZ and are therefore not in the report.
- **[A-3]** Subsequent debits/credits are intentionally excluded.
- **[A-4]** Users and frequency as stated; not in the source.
- **[A-5]** Volume in the tens of thousands of items per run.

## 14. Open questions (the reference leaves these unresolved)

| ID | Question | Why it matters |
|---|---|---|
| Q-1 | Scheduling agreements (`BSTYP = 'L'`) are selected, but the PO hotspot always calls `ME23N`. Should it call `ME33L` for agreements? | ME23N cannot display a scheduling agreement → drill-down fails for those rows. |
| Q-2 | Should the report check purchasing authorizations (`M_BEST_*` / `M_RAHM_*`) per company code / plant / purchasing org? | Today any user who can start the report sees all PO values of the selected company code. |
| Q-3 | Should subsequent debits/credits (`VGABE = '3'`) count toward "actual" cost in IR mode? | Price corrections after invoice are currently missing from actual landed cost. |
| Q-4 | Insurance has no default condition types. Which ones does the customer use? | Without them insurance lands in "Other". |
| Q-5 | Should blocked items (`LOEKZ = 'S'`) be excluded like deleted ones? | Only `'L'` is excluded today. |
| Q-6 | Should subtotal rows show a weighted DC %? | DC % is blank on subtotal rows. |
| Q-7 | Labels are hard-coded English literals. Is translation required? | Literals cannot be translated via SE63. |

## 15. Test scenarios

*Acceptance cases the QA Engineer (or the golden test) runs.*

| # | Scenario | Expected |
|---|---|---|
| T-1 | PO item with 1 GR, freight FRB1 = 50, material value 1 000 | Freight 50, landed 1 050, DC % 5.00 |
| T-2 | Same item, GR reversed (movement 102) | Qty and value net to 0; item hidden unless `P_OPEN` |
| T-3 | IR basis, invoice with customs ZOA1 = 30 and unknown condition ZXX1 = 10 | Customs 30, Other 10 |
| T-4 | `S_KINS` empty | No delivery cost goes to Insurance |
| T-5 | Two company codes in EUR and USD | Totals split by currency |
| T-6 | Click PO / material | ME23N / MM03 open with the right document |
| T-7 | Selection with no hits | Message FR-14, stays on selection screen |
| T-8 | Text item without material | Material hotspot does nothing |
