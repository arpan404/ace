// oxlint-disable-next-line import/no-unassigned-import -- Install the standard ES copy helper before the shared SDK starts.
import "core-js/actual/array/to-sorted.js";
// oxlint-disable-next-line import/no-unassigned-import -- Other portable SDK views also use non-mutating reverse.
import "core-js/actual/array/to-reversed.js";
import { registerRootComponent } from "expo";
import { App } from "./src/App.tsx";
registerRootComponent(App);
