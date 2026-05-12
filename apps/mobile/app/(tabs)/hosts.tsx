import React from "react";
import { Redirect } from "expo-router";

export default function HostsRedirect() {
  return <Redirect href="/settings" />;
}
