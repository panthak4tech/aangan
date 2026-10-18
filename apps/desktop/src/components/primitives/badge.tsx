import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        estimate: "border-dashed border-border bg-muted text-muted-foreground font-medium",
        measured: "border-transparent bg-fit-great text-fit-foreground font-medium",
        unknown: "border-border bg-transparent text-muted-foreground font-medium",
        "fit-great": "border-transparent bg-fit-great text-fit-foreground",
        "fit-good": "border-transparent bg-fit-good text-fit-foreground",
        "fit-slow": "border-transparent bg-fit-slow text-fit-foreground",
        "fit-too-slow": "border-transparent bg-fit-too-slow text-fit-foreground",
        "fit-wont-fit": "border-transparent bg-fit-wont-fit text-fit-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
