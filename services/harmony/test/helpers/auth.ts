import { stub, match, SinonStub } from 'sinon';
import axios from 'axios';
import { serialize } from 'cookie';
import { sign } from 'cookie-signature';
import { prototype } from 'simple-oauth2/lib/client';
import { Plugin, SuperAgentRequest } from 'superagent';
import { Token } from 'simple-oauth2';

/**
 * Stubs Earthdata Login HTTP calls exactly matching the given URL and parameters, returning the
 * the supplied response rather than making the call
 *
 * @param url - The URL of the call to stub
 * @param params - An object containing the URL parameters of the call to stub
 * @param response - A response object corresponding to the deserialized JSON that Earthdata
 *   Login would return
 * @returns The sinon stub that was created
 */
export function stubEdlRequest(url: string, params: object, response: object): SinonStub {
  return stub(prototype, 'request').withArgs(url, params).resolves(response);
}

/**
 * Stubs Earthdata Login HTTP calls exactly matching the given URL and parameters, such that they
 * throw an error with the given message.  simple-oauth2 throws errors when HTTP calls to the
 * backend are unsuccessful, so this allows testing cases such as a token being invalid
 *
 * @param url - The URL of the call to stub
 * @param params - An object containing the URL parameters of the call to stub
 * @param message - The thrown exception's message
 * @returns The sinon stub that was created
 */
export function stubEdlError(url: string, params: object, message: string): SinonStub {
  const error = new Error(message);
  return stub(prototype, 'request').withArgs(url, params).throws(error);
}

/**
 * Removes stubs from Earthdata Login requests
 */
export function unstubEdlRequest(): void {
  prototype.request.restore();
}

/**
 * Returns an object that has the structure of an OAuth2 token
 *
 * @param options - Configuration options
 * @returns An OAuth2-structured object representing the token
 */
export function token({
  username = 'mock_user',
  expiresDelta = 3600,
  accessToken = 'fake_access',
  refreshToken = 'fake_refresh',
}): Token {
  return {
    token_type: 'Bearer',
    access_token: accessToken,
    refresh_token: refreshToken,
    endpoint: `/api/users/${username}`,
    expires_in: 3600,
    expires_at: new Date(Date.now() + expiresDelta).toISOString(),
  };
}

/**
 * Given a cookie name, cookie data, and a signing secret, returns a cookie header string
 * that assigns the named cookie to a JSON-serialized, signed representation of the data
 *
 * @param name - The name of the cookie
 * @param data - The data value to set the cookie to
 * @param secret - The cookie signing secret
 * @returns The serialized, signed cookie header
 */
function signedCookie(name: string, data: string | object, secret: string): string {
  // Serialize prefixed with 'j:' so express recognizes it as a JSON object when deserializing
  const serialized = `j:${JSON.stringify(data)}`;
  // Sign and then prefix with 's:' so express recognizes it as a signed cookie when deserializing
  const signed = `s:${sign(serialized, secret)}`;
  return serialize(name, signed);
}

/**
 * Superagent plugin that logs the client in without making actual Earthdata Login calls
 *
 * @param options - Options to customize the behavior of the call
 * @returns The chainable supertest object with appropriate auth headers
 */
export function auth({
  username = 'mock_user',
  secret = process.env.COOKIE_SECRET,
  expired = false,
  extraCookies = null,
}): Plugin {
  const expiresIn = 3600;
  const expiresDelta = expired ? -expiresIn : expiresIn;
  const cookieData = token({
    username,
    expiresDelta,
  });

  let cookieStr = signedCookie('token', cookieData, secret);
  if (extraCookies) {
    Object.keys(extraCookies).forEach((key) => {
      const value = extraCookies[key];
      const newCookie = signedCookie(key, value, secret);
      cookieStr = `${cookieStr};${newCookie}`;
    });
  }

  // Stub the call to validate the token
  let fakePost = (axios.post as SinonStub);
  if (!fakePost.restore) {
    fakePost = stub(axios, 'post');
  }
  fakePost.resetHistory();
  fakePost.withArgs(
    match(/\/oauth\/tokens\/user\?token=/),
    null,
    match.object,
  ).returns(null);
  fakePost.callThrough();

  return (request): SuperAgentRequest => request.set('Cookie', cookieStr);
}

/**
 * Superagent plugin that adds a cookie to a request that mimics that provided by
 * EDL authorization when it needs to redirect the client to a new URL after login.
 *
 * @param location - The location the redirect should send the user to
 * @returns A function that sets the redirect cookie
 */
export function authRedirect(
  location: string, secret: string = process.env.COOKIE_SECRET,
): Plugin {
  const cookieStr = signedCookie('redirect', location, secret);
  return (request): SuperAgentRequest => request.set('Cookie', cookieStr);
}
