import { Provider } from "@smithy-io/types";
export const invalidProvider: (message: string) => Provider<any> = (message: string) => () => Promise.reject(message);
