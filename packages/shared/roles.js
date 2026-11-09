export const WORKBENCH_ROLES = Object.freeze(['employee', 'manager']);
export const canUseWorkbench = role => WORKBENCH_ROLES.includes(role);
