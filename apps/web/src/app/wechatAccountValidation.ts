export type WeChatAccountIdentity = {
  inputName?: unknown;
  finderUsername?: unknown;
};

const finderUsernamePattern = /^v2_[^\s@]+@finder$/i;

export const isFinderUsername = (value: unknown): value is string =>
  typeof value === "string" && finderUsernamePattern.test(value.trim());

export const isConfirmedWechatAccount = (
  inputName: string,
  candidate: unknown,
): candidate is WeChatAccountIdentity => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const account = candidate as WeChatAccountIdentity;
  return String(account.inputName || "").trim() === inputName && isFinderUsername(account.finderUsername);
};

export const retainConfirmedWechatAccounts = <T extends WeChatAccountIdentity>(
  inputNames: string[],
  accounts: Record<string, T>,
): Record<string, T> => Object.fromEntries(
  inputNames
    .filter(inputName => isConfirmedWechatAccount(inputName, accounts[inputName]))
    .map(inputName => [inputName, accounts[inputName]]),
) as Record<string, T>;
