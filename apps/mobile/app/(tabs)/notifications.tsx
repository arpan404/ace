import React from "react";
import { Redirect } from "expo-router";

export default function NotificationsRedirect() {
  return <Redirect href={{ pathname: "/", params: { filter: "attention" } }} />;
}
