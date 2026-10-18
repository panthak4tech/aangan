import { Badge } from "@/components/primitives/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/primitives/tooltip";
import { en } from "@/i18n/en";

export function EstimateBadge({ tps }: { tps: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-display text-sm tabular-nums text-foreground">
        {en.estimate.approx}
        {tps.toFixed(tps < 10 ? 1 : 0)} {en.estimate.unit}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="estimate">{en.estimate.badge}</Badge>
        </TooltipTrigger>
        <TooltipContent>{en.estimate.tooltip}</TooltipContent>
      </Tooltip>
    </span>
  );
}
