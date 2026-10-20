import type { Fit } from "@/api/types";
import { Badge } from "@/components/primitives/badge";
import { en } from "@/i18n/en";
import { FIT_VARIANT } from "./fit";

export function FitBadge({ fit }: { fit: Fit }) {
  return <Badge variant={FIT_VARIANT[fit]}>{en.fit[fit]}</Badge>;
}
