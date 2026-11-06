import type { JSX } from "preact";
import type { ScreenProps } from "../router";
import { SupplierList } from "./suppliers/list";
import { SupplierRecord } from "./suppliers/record";
import "./suppliers.css";

// ia.md section 7. #suppliers (and #suppliers?q=…) is the list; #supplier/K is one
// record, K its Airwallex beneficiary id. #supplier with no key is the list.
export function Suppliers(props: ScreenProps): JSX.Element {
  return props.route.word === "supplier" && props.route.segments.length > 0 ? (
    <SupplierRecord route={props.route} />
  ) : (
    <SupplierList route={props.route} />
  );
}
