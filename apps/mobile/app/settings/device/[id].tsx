import { Redirect, useLocalSearchParams } from "expo-router";

export default function DeviceSettingsRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: "/host/[hostId]", params: { hostId: id } }} />;
}
