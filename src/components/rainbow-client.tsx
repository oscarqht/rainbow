"use client";

import { useEffect, useState } from "react";
import { RainbowApp } from "./rainbow-app";

export function RainbowClient() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return <RainbowApp isHydrated={mounted} />;
}
