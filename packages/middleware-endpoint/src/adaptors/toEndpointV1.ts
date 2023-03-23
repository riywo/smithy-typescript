import { Endpoint, EndpointV2 } from "@smithy-io/types";
import { parseUrl } from "@smithy-io/url-parser";

export const toEndpointV1 = (endpoint: string | Endpoint | EndpointV2): Endpoint => {
  if (typeof endpoint === "object") {
    if ("url" in endpoint) {
      // v2
      return parseUrl(endpoint.url);
    }
    // v1
    return endpoint;
  }
  return parseUrl(endpoint);
};
