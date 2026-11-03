*&---------------------------------------------------------------------*
*& Report ZMM_LANDED_COST
*&---------------------------------------------------------------------*
*& Landed Cost Report (S/4HANA, MM)
*&
*& For every purchase order item the report shows the material value
*& received (or invoiced) together with the delivery costs posted
*& against it - split into Freight / Customs / Insurance / Other - the
*& resulting landed cost, the landed cost per unit and the delivery
*& cost share in percent. Output is an ALV grid (CL_SALV_TABLE) with
*& subtotals per Company Code and Plant and a Grand Total.
*&
*& Sources : EKKO / EKPO  Purchasing document header / item
*&           EKBE         PO history        (VGABE 1 = GR, 2 = IR)
*&           EKBZ         PO history of delivery costs (per KSCHL)
*&           LFA1         Vendor name
*&           T001         Company code currency
*&
*& All amounts are in company code currency (EKBE/EKBZ-DMBTR).
*& Quantities are in the order unit (EKPO-MEINS).
*&---------------------------------------------------------------------*
REPORT zmm_landed_cost.

TABLES: ekko, ekpo, ekbz.

*---------------------------------------------------------------------*
* TYPES
*---------------------------------------------------------------------*
TYPES: BEGIN OF ty_out,
         bukrs     TYPE ekko-bukrs,    " Company Code
         werks     TYPE ekpo-werks,    " Plant
         ebeln     TYPE ekpo-ebeln,    " Purchasing Document
         ebelp     TYPE ekpo-ebelp,    " Item
         bedat     TYPE ekko-bedat,    " Document Date
         lifnr     TYPE ekko-lifnr,    " Vendor
         name1     TYPE lfa1-name1,    " Vendor Name
         matnr     TYPE ekpo-matnr,    " Material
         txz01     TYPE ekpo-txz01,    " Short Text
         po_qty    TYPE ekpo-menge,    " PO Quantity
         rcv_qty   TYPE ekbe-menge,    " Received / Invoiced Quantity
         meins     TYPE ekpo-meins,    " Order Unit
         hwaer     TYPE t001-waers,    " Company Code Currency
         mat_value TYPE ekbe-dmbtr,    " Material Value
         freight   TYPE ekbz-dmbtr,    " Freight
         customs   TYPE ekbz-dmbtr,    " Customs / Duty
         insurance TYPE ekbz-dmbtr,    " Insurance
         other_dc  TYPE ekbz-dmbtr,    " Other Delivery Costs
         total_dc  TYPE ekbz-dmbtr,    " Total Delivery Costs
         landed    TYPE ekbz-dmbtr,    " Landed Cost
         unit_lc   TYPE ekbz-dmbtr,    " Landed Cost per Unit
         dc_pct    TYPE p LENGTH 8 DECIMALS 2, " Delivery Cost %
       END OF ty_out.

TYPES: BEGIN OF ty_ekbe,
         ebeln TYPE ekbe-ebeln,
         ebelp TYPE ekbe-ebelp,
         zekkn TYPE ekbe-zekkn,
         vgabe TYPE ekbe-vgabe,
         gjahr TYPE ekbe-gjahr,
         belnr TYPE ekbe-belnr,
         buzei TYPE ekbe-buzei,
         shkzg TYPE ekbe-shkzg,
         menge TYPE ekbe-menge,
         dmbtr TYPE ekbe-dmbtr,
       END OF ty_ekbe,
       tt_ekbe TYPE SORTED TABLE OF ty_ekbe WITH NON-UNIQUE KEY ebeln ebelp.

TYPES: BEGIN OF ty_ekbz,
         ebeln TYPE ekbz-ebeln,
         ebelp TYPE ekbz-ebelp,
         stunr TYPE ekbz-stunr,
         zaehk TYPE ekbz-zaehk,
         vgabe TYPE ekbz-vgabe,
         gjahr TYPE ekbz-gjahr,
         belnr TYPE ekbz-belnr,
         buzei TYPE ekbz-buzei,
         kschl TYPE ekbz-kschl,
         shkzg TYPE ekbz-shkzg,
         dmbtr TYPE ekbz-dmbtr,
       END OF ty_ekbz,
       tt_ekbz TYPE SORTED TABLE OF ty_ekbz WITH NON-UNIQUE KEY ebeln ebelp.

TYPES: BEGIN OF ty_coltext,
         name   TYPE lvc_fname,
         short  TYPE scrtext_s,
         medium TYPE scrtext_m,
         long   TYPE scrtext_l,
       END OF ty_coltext,
       tt_coltext TYPE STANDARD TABLE OF ty_coltext WITH EMPTY KEY.

*---------------------------------------------------------------------*
* DATA
*---------------------------------------------------------------------*
DATA: gt_out TYPE STANDARD TABLE OF ty_out,
      go_alv TYPE REF TO cl_salv_table.

*---------------------------------------------------------------------*
* SELECTION SCREEN
*---------------------------------------------------------------------*
* Every field has its own label (COMMENT ... FOR FIELD) and every block
* its own title. Labels and titles are filled in INITIALIZATION, so the
* screen shows proper names even without maintained text elements.
SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE t_b1.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_bukrs FOR FIELD s_bukrs.
SELECT-OPTIONS s_bukrs FOR ekko-bukrs OBLIGATORY.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_werks FOR FIELD s_werks.
SELECT-OPTIONS s_werks FOR ekpo-werks.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_ebeln FOR FIELD s_ebeln.
SELECT-OPTIONS s_ebeln FOR ekko-ebeln.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_lifnr FOR FIELD s_lifnr.
SELECT-OPTIONS s_lifnr FOR ekko-lifnr.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_matnr FOR FIELD s_matnr.
SELECT-OPTIONS s_matnr FOR ekpo-matnr.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_bedat FOR FIELD s_bedat.
SELECT-OPTIONS s_bedat FOR ekko-bedat.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN END OF BLOCK b1.

SELECTION-SCREEN BEGIN OF BLOCK b2 WITH FRAME TITLE t_b2.

SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_gr RADIOBUTTON GROUP bas DEFAULT 'X'.
SELECTION-SCREEN COMMENT 3(40) c_gr FOR FIELD p_gr.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_ir RADIOBUTTON GROUP bas.
SELECTION-SCREEN COMMENT 3(40) c_ir FOR FIELD p_ir.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN SKIP 1.

SELECTION-SCREEN BEGIN OF LINE.
PARAMETERS p_open AS CHECKBOX.
SELECTION-SCREEN COMMENT 3(40) c_open FOR FIELD p_open.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN END OF BLOCK b2.

SELECTION-SCREEN BEGIN OF BLOCK b3 WITH FRAME TITLE t_b3.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_kfrt FOR FIELD s_kfrt.
SELECT-OPTIONS s_kfrt FOR ekbz-kschl NO INTERVALS.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_kcus FOR FIELD s_kcus.
SELECT-OPTIONS s_kcus FOR ekbz-kschl NO INTERVALS.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN BEGIN OF LINE.
SELECTION-SCREEN COMMENT 1(31) c_kins FOR FIELD s_kins.
SELECT-OPTIONS s_kins FOR ekbz-kschl NO INTERVALS.
SELECTION-SCREEN END OF LINE.

SELECTION-SCREEN END OF BLOCK b3.

* Delivery costs whose condition type is in none of the three lists
* are reported as "Other Delivery Costs".

*---------------------------------------------------------------------*
* EVENT HANDLER
*---------------------------------------------------------------------*
CLASS lcl_events DEFINITION.
  PUBLIC SECTION.
    CLASS-METHODS on_link_click
      FOR EVENT link_click OF cl_salv_events_table
      IMPORTING row column.
ENDCLASS.

CLASS lcl_events IMPLEMENTATION.
  METHOD on_link_click.
    READ TABLE gt_out INTO DATA(ls_out) INDEX row.
    CHECK sy-subrc = 0.

    CASE column.
      WHEN 'EBELN'.
        SET PARAMETER ID 'BES' FIELD ls_out-ebeln.
        CALL TRANSACTION 'ME23N' WITH AUTHORITY-CHECK.
      WHEN 'MATNR'.
        CHECK ls_out-matnr IS NOT INITIAL.
        SET PARAMETER ID 'MAT' FIELD ls_out-matnr.
        CALL TRANSACTION 'MM03' WITH AUTHORITY-CHECK AND SKIP FIRST SCREEN.
    ENDCASE.
  ENDMETHOD.
ENDCLASS.

*---------------------------------------------------------------------*
* INITIALIZATION
*---------------------------------------------------------------------*
INITIALIZATION.

* Block titles
  t_b1 = 'Purchasing Data'.
  t_b2 = 'Cost Basis'.
  t_b3 = 'Delivery Cost Condition Types'.

* Field labels
  c_bukrs = 'Company Code'.
  c_werks = 'Plant'.
  c_ebeln = 'Purchase Order'.
  c_lifnr = 'Vendor'.
  c_matnr = 'Material'.
  c_bedat = 'PO Document Date'.
  c_gr    = 'Goods Receipt (Accrued Cost)'.
  c_ir    = 'Invoice Receipt (Actual Cost)'.
  c_open  = 'Include Items without GR / IR'.
  c_kfrt  = 'Freight Condition Types'.
  c_kcus  = 'Customs / Duty Condition Types'.
  c_kins  = 'Insurance Condition Types'.

* Default delivery cost condition types of the standard MM pricing
* procedure - adjust to the customer pricing procedure if needed
  s_kfrt[] = VALUE #( sign = 'I' option = 'EQ'
                      ( low = 'FRA1' ) ( low = 'FRB1' ) ( low = 'FRC1' ) ).
  s_kcus[] = VALUE #( sign = 'I' option = 'EQ'
                      ( low = 'ZOA1' ) ( low = 'ZOB1' ) ( low = 'ZOC1' ) ).

*---------------------------------------------------------------------*
* START OF SELECTION
*---------------------------------------------------------------------*
START-OF-SELECTION.

  PERFORM get_data.

  IF gt_out IS INITIAL.
    MESSAGE 'No purchase order items found for the given selection'
      TYPE 'S' DISPLAY LIKE 'E'.
    RETURN.
  ENDIF.

  PERFORM display_alv.

*&---------------------------------------------------------------------*
*& Form GET_DATA
*&---------------------------------------------------------------------*
FORM get_data.

  DATA: lt_ekbe   TYPE tt_ekbe,
        lt_ekbz   TYPE tt_ekbz,
        lv_vgabe  TYPE ekbe-vgabe,
        lv_amount TYPE ekbz-dmbtr.

* Cost basis: goods receipt (accrued) or invoice receipt (actual)
  lv_vgabe = COND #( WHEN p_ir = abap_true THEN '2' ELSE '1' ).

* Purchase order / scheduling agreement items within the selection
  SELECT k~bukrs, p~werks, p~ebeln, p~ebelp, k~bedat, k~lifnr,
         v~name1, p~matnr, p~txz01, p~menge AS po_qty, p~meins,
         c~waers AS hwaer
    FROM ekko AS k
    INNER JOIN ekpo AS p ON p~ebeln = k~ebeln
    INNER JOIN t001 AS c ON c~bukrs = k~bukrs
    LEFT OUTER JOIN lfa1 AS v ON v~lifnr = k~lifnr
    WHERE k~bukrs IN @s_bukrs
      AND k~ebeln IN @s_ebeln
      AND k~lifnr IN @s_lifnr
      AND k~bedat IN @s_bedat
      AND k~bstyp IN ( 'F', 'L' )
      AND p~werks IN @s_werks
      AND p~matnr IN @s_matnr
      AND p~loekz <> 'L'
    INTO CORRESPONDING FIELDS OF TABLE @gt_out.

  IF gt_out IS INITIAL.
    RETURN.
  ENDIF.

* Material value and quantity from the PO history. The full EKBE key is
* selected so FOR ALL ENTRIES does not drop identical postings.
  SELECT ebeln, ebelp, zekkn, vgabe, gjahr, belnr, buzei,
         shkzg, menge, dmbtr
    FROM ekbe
    FOR ALL ENTRIES IN @gt_out
    WHERE ebeln = @gt_out-ebeln
      AND ebelp = @gt_out-ebelp
      AND vgabe = @lv_vgabe
    INTO CORRESPONDING FIELDS OF TABLE @lt_ekbe.

* Delivery costs per condition type from the delivery cost history
  SELECT ebeln, ebelp, stunr, zaehk, vgabe, gjahr, belnr, buzei,
         kschl, shkzg, dmbtr
    FROM ekbz
    FOR ALL ENTRIES IN @gt_out
    WHERE ebeln = @gt_out-ebeln
      AND ebelp = @gt_out-ebelp
      AND vgabe = @lv_vgabe
    INTO CORRESPONDING FIELDS OF TABLE @lt_ekbz.

  LOOP AT gt_out ASSIGNING FIELD-SYMBOL(<ls_out>).

*   Received (invoiced) quantity and material value, reversals and
*   credit memos (SHKZG = 'H') reduce the totals
    LOOP AT lt_ekbe ASSIGNING FIELD-SYMBOL(<ls_ekbe>)
         WHERE ebeln = <ls_out>-ebeln
           AND ebelp = <ls_out>-ebelp.
      IF <ls_ekbe>-shkzg = 'H'.
        <ls_out>-rcv_qty   = <ls_out>-rcv_qty   - <ls_ekbe>-menge.
        <ls_out>-mat_value = <ls_out>-mat_value - <ls_ekbe>-dmbtr.
      ELSE.
        <ls_out>-rcv_qty   = <ls_out>-rcv_qty   + <ls_ekbe>-menge.
        <ls_out>-mat_value = <ls_out>-mat_value + <ls_ekbe>-dmbtr.
      ENDIF.
    ENDLOOP.

*   Delivery costs split by condition type. An empty select-option
*   would match every condition type, so it is checked first.
    LOOP AT lt_ekbz ASSIGNING FIELD-SYMBOL(<ls_ekbz>)
         WHERE ebeln = <ls_out>-ebeln
           AND ebelp = <ls_out>-ebelp.
      lv_amount = COND #( WHEN <ls_ekbz>-shkzg = 'H'
                          THEN - <ls_ekbz>-dmbtr
                          ELSE <ls_ekbz>-dmbtr ).
      IF s_kfrt[] IS NOT INITIAL AND <ls_ekbz>-kschl IN s_kfrt.
        <ls_out>-freight   = <ls_out>-freight   + lv_amount.
      ELSEIF s_kcus[] IS NOT INITIAL AND <ls_ekbz>-kschl IN s_kcus.
        <ls_out>-customs   = <ls_out>-customs   + lv_amount.
      ELSEIF s_kins[] IS NOT INITIAL AND <ls_ekbz>-kschl IN s_kins.
        <ls_out>-insurance = <ls_out>-insurance + lv_amount.
      ELSE.
        <ls_out>-other_dc  = <ls_out>-other_dc  + lv_amount.
      ENDIF.
    ENDLOOP.

*   Landed cost = material value + all delivery costs
    <ls_out>-total_dc = <ls_out>-freight + <ls_out>-customs
                      + <ls_out>-insurance + <ls_out>-other_dc.
    <ls_out>-landed   = <ls_out>-mat_value + <ls_out>-total_dc.

    IF <ls_out>-rcv_qty <> 0.
      <ls_out>-unit_lc = <ls_out>-landed / <ls_out>-rcv_qty.
    ENDIF.

    IF <ls_out>-mat_value <> 0.
      <ls_out>-dc_pct = <ls_out>-total_dc / <ls_out>-mat_value * 100.
    ENDIF.

  ENDLOOP.

* Drop items without any GR / IR history unless requested
  IF p_open = abap_false.
    DELETE gt_out WHERE rcv_qty   = 0
                    AND mat_value = 0
                    AND total_dc  = 0.
  ENDIF.

ENDFORM.

*&---------------------------------------------------------------------*
*& Form DISPLAY_ALV
*&---------------------------------------------------------------------*
FORM display_alv.

  DATA: lt_amounts TYPE STANDARD TABLE OF lvc_fname WITH EMPTY KEY.

  TRY.
      cl_salv_table=>factory(
        IMPORTING r_salv_table = go_alv
        CHANGING  t_table      = gt_out ).

*     Enable standard ALV functions (sort, filter, export, layout ...)
      go_alv->get_functions( )->set_all( abap_true ).

*     Allow users to save layout variants
      DATA(lr_layout) = go_alv->get_layout( ).
      lr_layout->set_key( VALUE salv_s_layout_key( report = sy-repid ) ).
      lr_layout->set_save_restriction( if_salv_c_layout=>restrict_none ).
      lr_layout->set_default( abap_true ).

      DATA(lr_cols) = go_alv->get_columns( ).
      lr_cols->set_optimize( abap_true ).

*     Column headings for the calculated / renamed columns
      DATA(lt_text) = VALUE tt_coltext(
        ( name = 'PO_QTY'    short = 'PO Qty'     medium = 'PO Quantity'
          long = 'PO Quantity' )
        ( name = 'RCV_QTY'   short = 'Rcvd Qty'   medium = 'Received Quantity'
          long = 'Received / Invoiced Quantity' )
        ( name = 'HWAER'     short = 'Currency'   medium = 'CoCode Currency'
          long = 'Company Code Currency' )
        ( name = 'MAT_VALUE' short = 'Mat.Value'  medium = 'Material Value'
          long = 'Material Value' )
        ( name = 'FREIGHT'   short = 'Freight'    medium = 'Freight'
          long = 'Freight' )
        ( name = 'CUSTOMS'   short = 'Customs'    medium = 'Customs / Duty'
          long = 'Customs / Duty' )
        ( name = 'INSURANCE' short = 'Insurance'  medium = 'Insurance'
          long = 'Insurance' )
        ( name = 'OTHER_DC'  short = 'Other DC'   medium = 'Other Deliv. Costs'
          long = 'Other Delivery Costs' )
        ( name = 'TOTAL_DC'  short = 'Total DC'   medium = 'Total Deliv. Costs'
          long = 'Total Delivery Costs' )
        ( name = 'LANDED'    short = 'Landed'     medium = 'Landed Cost'
          long = 'Landed Cost' )
        ( name = 'UNIT_LC'   short = 'LC / Unit'  medium = 'Landed Cost / Unit'
          long = 'Landed Cost per Unit' )
        ( name = 'DC_PCT'    short = 'DC %'       medium = 'Deliv. Cost %'
          long = 'Delivery Cost % of Material Value' ) ).

      LOOP AT lt_text INTO DATA(ls_text).
        DATA(lr_text_col) = lr_cols->get_column( ls_text-name ).
        lr_text_col->set_short_text( ls_text-short ).
        lr_text_col->set_medium_text( ls_text-medium ).
        lr_text_col->set_long_text( ls_text-long ).
      ENDLOOP.

*     Amounts refer to the company code currency, quantities to the
*     order unit
      lt_amounts = VALUE #( ( 'MAT_VALUE' ) ( 'FREIGHT' ) ( 'CUSTOMS' )
                            ( 'INSURANCE' ) ( 'OTHER_DC' ) ( 'TOTAL_DC' )
                            ( 'LANDED' ) ( 'UNIT_LC' ) ).
      LOOP AT lt_amounts INTO DATA(lv_amount_col).
        lr_cols->get_column( lv_amount_col )->set_currency_column( 'HWAER' ).
      ENDLOOP.
      lr_cols->get_column( 'PO_QTY'  )->set_quantity_column( 'MEINS' ).
      lr_cols->get_column( 'RCV_QTY' )->set_quantity_column( 'MEINS' ).

*     Hotspots: PO -> ME23N, Material -> MM03
      DATA(lr_col_ebeln) = CAST cl_salv_column_table(
                             lr_cols->get_column( 'EBELN' ) ).
      lr_col_ebeln->set_cell_type( if_salv_c_cell_type=>hotspot ).
      DATA(lr_col_matnr) = CAST cl_salv_column_table(
                             lr_cols->get_column( 'MATNR' ) ).
      lr_col_matnr->set_cell_type( if_salv_c_cell_type=>hotspot ).

      DATA(lr_events) = go_alv->get_event( ).
      SET HANDLER lcl_events=>on_link_click FOR lr_events.

*     Sort with subtotals per Company Code and Plant
      DATA(lr_sorts) = go_alv->get_sorts( ).
      lr_sorts->add_sort(
        columnname = 'BUKRS'
        sequence   = if_salv_c_sort=>sort_up
        subtotal   = if_salv_c_bool_sap=>true ).
      lr_sorts->add_sort(
        columnname = 'WERKS'
        sequence   = if_salv_c_sort=>sort_up
        subtotal   = if_salv_c_bool_sap=>true ).
      lr_sorts->add_sort(
        columnname = 'EBELN'
        sequence   = if_salv_c_sort=>sort_up ).
      lr_sorts->add_sort(
        columnname = 'EBELP'
        sequence   = if_salv_c_sort=>sort_up ).

*     Totals for all value columns (per unit cost and % are not summed)
      DATA(lr_aggr) = go_alv->get_aggregations( ).
      LOOP AT lt_amounts INTO lv_amount_col WHERE table_line <> 'UNIT_LC'.
        lr_aggr->add_aggregation(
          columnname  = lv_amount_col
          aggregation = if_salv_c_aggregation=>total ).
      ENDLOOP.

*     Display settings
      DATA(lr_display) = go_alv->get_display_settings( ).
      lr_display->set_striped_pattern( abap_true ).
      lr_display->set_list_header(
        COND #( WHEN p_ir = abap_true
                THEN 'Landed Cost Report - Invoice Receipt (Actual)'
                ELSE 'Landed Cost Report - Goods Receipt (Accrued)' ) ).

      go_alv->display( ).

    CATCH cx_salv_msg INTO DATA(lx_msg).
      MESSAGE lx_msg->get_text( ) TYPE 'E'.
    CATCH cx_salv_not_found INTO DATA(lx_nf).
      MESSAGE lx_nf->get_text( ) TYPE 'E'.
    CATCH cx_salv_existing INTO DATA(lx_ex).
      MESSAGE lx_ex->get_text( ) TYPE 'E'.
    CATCH cx_salv_data_error INTO DATA(lx_de).
      MESSAGE lx_de->get_text( ) TYPE 'E'.
  ENDTRY.

ENDFORM.
