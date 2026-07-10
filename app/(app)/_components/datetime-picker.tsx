"use client";

import { useState } from "react";
import { format } from "date-fns";
import { CalendarClock, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// value dạng "YYYY-MM-DDTHH:mm" (giờ VN) hoặc "" = đăng ngay.
function parseValue(value: string): { date: Date | undefined; time: string } {
  if (!value) return { date: undefined, time: "" };
  const [d, t] = value.split("T");
  const dt = d ? new Date(`${d}T${t || "00:00"}:00`) : undefined;
  return { date: dt && !Number.isNaN(dt.getTime()) ? dt : undefined, time: t || "" };
}

export function DateTimePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(parseValue(value).time || "09:00");
  const selectedDate = parseValue(value).date;

  function emit(date: Date | undefined, t: string) {
    if (!date) {
      onChange("");
      return;
    }
    onChange(`${format(date, "yyyy-MM-dd")}T${t || "09:00"}`);
  }

  function pickTomorrow630() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    setTime("06:30");
    emit(d, "06:30");
    setOpen(false);
  }

  const label = selectedDate ? format(selectedDate, "HH:mm 'ngày' dd/MM/yyyy") : "Đăng ngay (mặc định)";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="justify-start font-normal">
            <CalendarClock className="text-muted-foreground" />
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="flex gap-2 border-b p-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              <Zap /> Đăng ngay
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={pickTomorrow630}>
              Sáng mai 6:30
            </Button>
          </div>
          <Calendar mode="single" selected={selectedDate} onSelect={(d) => emit(d, time)} />
          <div className="flex items-center gap-2 border-t p-3">
            <span className="text-sm text-muted-foreground">Giờ đăng</span>
            <Input
              type="time"
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                if (selectedDate) emit(selectedDate, e.target.value);
              }}
              className="w-32"
            />
          </div>
        </PopoverContent>
      </Popover>
      {value && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
          Xoá giờ hẹn
        </Button>
      )}
    </div>
  );
}
