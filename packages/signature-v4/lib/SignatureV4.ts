import {createScope, getSigningKey} from "./credentialDerivation";
import {getCanonicalHeaders} from './getCanonicalHeaders';
import {getCanonicalQuery} from "./getCanonicalQuery";
import {getPayloadHash} from "./getPayloadHash";
import {prepareRequest} from "./prepareRequest";
import {moveHeadersToQuery} from "./moveHeadersToQuery";
import {
    ALGORITHM_IDENTIFIER,
    ALGORITHM_QUERY_PARAM,
    AMZ_DATE_HEADER,
    AMZ_DATE_QUERY_PARAM,
    AUTH_HEADER,
    CREDENTIAL_QUERY_PARAM,
    EXPIRES_QUERY_PARAM,
    MAX_PRESIGNED_TTL,
    SHA256_HEADER,
    SIGNATURE_QUERY_PARAM,
    SIGNED_HEADERS_QUERY_PARAM,
    UNSIGNED_PAYLOAD,
    TOKEN_HEADER,
    TOKEN_QUERY_PARAM,
    UNSIGNABLE_HEADERS,
} from './constants';
import {
    Credentials,
    HashConstructor,
    HeaderBag,
    HttpRequest,
    Provider,
    QueryParameterBag,
    RequestPresigningArguments as PresigningArguments,
    RequestSigner,
    RequestSigningArguments as SigningArguments,
} from '@aws/types';
import {isCredentials} from '@aws/credential-provider-base';
import {iso8601, toDate} from '@aws/protocol-timestamp';
import {toHex} from '@aws/util-hex-encoding';

export interface SignatureV4Init {
    service: string;
    region: string|Provider<string>,
    credentials: Credentials|Provider<Credentials>,
    sha256: HashConstructor;
    unsignedPayload?: boolean;
}

export class SignatureV4 implements RequestSigner {
    private readonly service: string;
    private readonly regionProvider: Provider<string>;
    private readonly credentialProvider: Provider<Credentials>;
    protected readonly sha256: HashConstructor;
    protected readonly unsignedPayload: boolean;

    constructor(options: SignatureV4Init) {
        this.service = options.service;
        this.sha256 = options.sha256;
        this.unsignedPayload = options.unsignedPayload === true;

        if (typeof options.region === 'string') {
            const promisified = Promise.resolve(options.region);
            this.regionProvider = () => promisified;
        } else {
            this.regionProvider = options.region;
        }

        if (isCredentials(options.credentials)) {
            const promisified = Promise.resolve(options.credentials);
            this.credentialProvider = () => promisified;
        } else {
            this.credentialProvider = options.credentials;
        }
    }

    presignRequest<StreamType>({
        request: originalRequest,
        expiration,
        signingDate = new Date(),
        hoistHeaders = true,
        unsignableHeaders = UNSIGNABLE_HEADERS,
    }: PresigningArguments<StreamType>): Promise<HttpRequest<StreamType>> {
        return Promise.all([this.regionProvider(), this.credentialProvider()])
            .then(([region, credentials]) => {
                const {longDate, shortDate} = formatDate(signingDate);
                const ttl = getTtl(signingDate, expiration);
                if (ttl > MAX_PRESIGNED_TTL) {
                    return Promise.reject('Signature version 4 presigned URLs'
                        + ' must have an expiration date less than one week in'
                        + ' the future');
                }

                const scope = createScope(shortDate, region, this.service);
                const keyPromise = this.getSigningKey(credentials, shortDate);

                const wrapperFn = hoistHeaders
                    ? moveHeadersToQuery
                    : ensureRequestHasQuery;
                const request = wrapperFn(prepareRequest(originalRequest));

                if (credentials.sessionToken) {
                    request.query[TOKEN_QUERY_PARAM] = credentials.sessionToken;
                }
                request.query[ALGORITHM_QUERY_PARAM] = ALGORITHM_IDENTIFIER;
                request.query[CREDENTIAL_QUERY_PARAM]
                    = `${credentials.accessKeyId}/${scope}`;
                request.query[AMZ_DATE_QUERY_PARAM] = longDate;
                request.query[EXPIRES_QUERY_PARAM] = ttl.toString(10);

                return this.getPresignedPayloadHash(request)
                    .then(payloadHash => {
                        const canonicalHeaders = getCanonicalHeaders(
                            request,
                            unsignableHeaders
                        );
                        request.query[SIGNED_HEADERS_QUERY_PARAM]
                            = getCanonicalHeaderList(canonicalHeaders);
                        const canonicalRequest = this.createCanonicalRequest(
                            request,
                            canonicalHeaders,
                            payloadHash
                        );

                        return this.getSignature(
                            longDate,
                            scope,
                            keyPromise,
                            canonicalRequest
                        )
                    }).then(signature => {
                        request.query[SIGNATURE_QUERY_PARAM] = signature;
                        return request;
                    });
            });
    }

    signRequest<StreamType>({
        request: originalRequest,
        signingDate = new Date(),
        unsignableHeaders = UNSIGNABLE_HEADERS,
    }: SigningArguments<StreamType>): Promise<HttpRequest<StreamType>> {
        return Promise.all([this.regionProvider(), this.credentialProvider()])
            .then(([region, credentials]) => {
                const request = prepareRequest(originalRequest);
                const {longDate, shortDate} = formatDate(signingDate);
                const scope = createScope(shortDate, region, this.service);
                const keyPromise = this.getSigningKey(credentials, shortDate);

                request.headers[AMZ_DATE_HEADER] = longDate;
                if (credentials.sessionToken) {
                    request.headers[TOKEN_HEADER] = credentials.sessionToken;
                }

                return this.getPayloadHash(request)
                    .then(payloadHash => {
                        if (payloadHash === UNSIGNED_PAYLOAD) {
                            request.headers[SHA256_HEADER] = UNSIGNED_PAYLOAD;
                        }
                        const canonicalHeaders = getCanonicalHeaders(
                            request,
                            unsignableHeaders
                        );
                        const canonicalRequest =  this.createCanonicalRequest(
                            request,
                            canonicalHeaders,
                            payloadHash
                        );

                        return this.getSignature(
                            longDate,
                            scope,
                            keyPromise,
                            canonicalRequest
                        ).then(signature => {
                            request.headers[AUTH_HEADER] = `${ALGORITHM_IDENTIFIER} `
                                + `Credential=${credentials.accessKeyId}/${scope}, `
                                + `SignedHeaders=${getCanonicalHeaderList(canonicalHeaders)}, `
                                + `Signature=${signature}`;
                            return request;
                        });
                    });
            });
    }

    protected getCanonicalPath(
        {path}: HttpRequest<any>
    ): string {
        const doubleEncoded = encodeURIComponent(path.replace(/^\//, ''));
        return `/${doubleEncoded.replace(/%2F/g, '/')}`;
    }

    protected getPresignedPayloadHash<StreamType>(
        request: HttpRequest<StreamType>
    ): Promise<string> {
        return this.getPayloadHash(request);
    }

    private createCanonicalRequest(
        request: HttpRequest<any>,
        canonicalHeaders: HeaderBag,
        payloadHash: string
    ): string {
        const sortedHeaders = Object.keys(canonicalHeaders).sort();
        return `${request.method}
${this.getCanonicalPath(request)}
${getCanonicalQuery(request)}
${sortedHeaders.map(name => `${name}:${canonicalHeaders[name]}`).join('\n')}

${sortedHeaders.join(';')}
${payloadHash}`;
    }

    private createStringToSign(
        longDate: string,
        credentialScope: string,
        canonicalRequest: string
    ): Promise<string> {
        const hash = new this.sha256();
        hash.update(canonicalRequest);

        return hash.digest().then(hashedRequest => (
`${ALGORITHM_IDENTIFIER}
${longDate}
${credentialScope}
${toHex(hashedRequest)}`
        ));
    }

    private getPayloadHash<StreamType>(
        request: HttpRequest<StreamType>
    ): Promise<string> {
        if (this.unsignedPayload && request.protocol === 'https:') {
            return Promise.resolve(UNSIGNED_PAYLOAD);
        }

        return getPayloadHash(request, this.sha256);
    }

    private getSignature(
        longDate: string,
        credentialScope: string,
        keyPromise: Promise<Uint8Array>,
        canonicalRequest: string
    ): Promise<string> {
        return this.createStringToSign(
            longDate,
            credentialScope,
            canonicalRequest
        ).then(stringToSign => {
            return keyPromise.then(key => {
                const hash = new this.sha256(key);
                hash.update(stringToSign);
                return hash.digest();
            });
        }).then(toHex);
    }

    private getSigningKey(
        credentials: Credentials,
        shortDate: string
    ): Promise<Uint8Array> {
        return this.regionProvider().then(region => getSigningKey(
            this.sha256,
            credentials,
            shortDate,
            region,
            this.service
        ));
    }
}

function ensureRequestHasQuery<StreamType>(
    request: HttpRequest<StreamType>
): HttpRequest<StreamType> & {query: QueryParameterBag} {
    const {query = {} as QueryParameterBag} = request;

    return {
        ...request,
        query
    };
}

function formatDate(
    now: string|number|Date
): {longDate: string, shortDate: string} {
    const longDate = iso8601(now).replace(/[\-:]/g, '');
    return {
        longDate,
        shortDate: longDate.substr(0, 8),
    };
}

function getCanonicalHeaderList(headers: object): string {
    return Object.keys(headers)
        .sort()
        .join(';');
}

function getTtl(
    start: string|number|Date,
    expiration: string|number|Date
): number {
    return Math.floor(
        (toDate(expiration).valueOf() - toDate(start).valueOf()) / 1000
    );
}
