-- KI-38 currency boundary: buy-list candidate loans need their own currency.
--
-- Without this field, a buy-list item selected in the switch simulator can be
-- silently treated as deal-currency collateral. That is only correct when the
-- candidate's currency is known to match the deal currency.

ALTER TABLE clo_buy_list_items
  ADD COLUMN IF NOT EXISTS currency TEXT;
