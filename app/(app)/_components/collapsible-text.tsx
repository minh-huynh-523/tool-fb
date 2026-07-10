"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";

// Nội dung bài: thu gọn 3 dòng, bấm để bung hết (collapse).
export function CollapsibleText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 200 || text.split("\n").length > 3;

  return (
    <div className="space-y-1">
      <p className={`whitespace-pre-wrap break-words text-foreground/90 ${open || !long ? "" : "line-clamp-3"}`}>{text}</p>
      {long && (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setOpen(!open)}>
          {open ? (
            <>
              <ChevronUp /> Thu gọn
            </>
          ) : (
            <>
              <ChevronDown /> Xem thêm
            </>
          )}
        </Button>
      )}
    </div>
  );
}
