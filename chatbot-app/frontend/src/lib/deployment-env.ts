/**
 * Deployment-identity helpers for the BFF routes.
 *
 * Every helper throws and names the missing variable rather than defaulting. A default here would
 * build an SSM path or DynamoDB table name for some other deployment and fail with an opaque
 * ParameterNotFound / AccessDenied, which reads as a permissions bug rather than as the missing
 * configuration value it actually is.
 *
 * Every helper is a function, never a module-level constant: `next build` evaluates route modules,
 * so throwing at import time would break the build rather than the request.
 */

/**
 * Resource-name prefix identifying this deployment, used to build SSM parameter paths.
 *
 * Prefers `PROJECT_NAME`; falls back to `NAME_PREFIX`, which the ECS task definition does set
 * (`infra/modules/frontend-ecs/main.tf`).
 *
 * @returns The project/resource-name prefix (e.g. `recon-dev`).
 * @throws Error if neither variable is set.
 */
export function projectName(): string {
  const value = process.env.PROJECT_NAME || process.env.NAME_PREFIX
  if (!value) {
    throw new Error(
      'Neither PROJECT_NAME nor NAME_PREFIX is set, so this deployment\'s resource-name prefix ' +
        'cannot be derived. NAME_PREFIX is set by the ECS task definition in ' +
        'infra/modules/frontend-ecs/main.tf.'
    )
  }
  return value
}

/**
 * Environment segment used in SSM parameter paths (`/<project>/<environment>/...`).
 *
 * Defaults to `dev` because the environment root hardcodes `environment = "dev"` for every module
 * that publishes a parameter in this shape (`infra/environments/recon/main.tf`) — so `dev` is the
 * factual value for this deployment, not a guess standing in for a missing one.
 *
 * @returns The environment name (e.g. `dev`).
 */
export function environmentName(): string {
  return process.env.ENVIRONMENT || 'dev'
}

/**
 * Name of the DynamoDB table holding user profiles and chat sessions.
 *
 * There is deliberately no fallback. This deployment provisions no users/sessions table — its
 * tables are items, cases, audit, lessons and gl_status — so any value here would be a guess at
 * another account's table. Callers of the user/session store are inherited scaffolding that this
 * deployment does not wire up; the throw makes that explicit at the first call rather than
 * surfacing as a cross-account AccessDenied.
 *
 * @returns The users/sessions table name.
 * @throws Error if `DYNAMODB_USERS_TABLE` is not set.
 */
export function usersTableName(): string {
  const value = process.env.DYNAMODB_USERS_TABLE
  if (!value) {
    throw new Error(
      'DYNAMODB_USERS_TABLE is not set. This deployment provisions no users/sessions table, so ' +
        'the user- and session-store code paths are unavailable; set the variable only if such a ' +
        'table is added to infra/.'
    )
  }
  return value
}
