import { Provider } from "@smithy-io/types";

export const fromStatic =
  <T>(staticValue: T): Provider<T> =>
  () =>
    Promise.resolve(staticValue);
