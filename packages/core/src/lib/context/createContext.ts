import type { IncomingMessage, ServerResponse } from 'http'
import { type ExecutionResult, graphql, type GraphQLSchema, print } from 'graphql'
import type { KeystoneContext, KeystoneGraphQLAPI, KeystoneConfig } from '../../types'

import type { PrismaClient } from '../core/utils'
import type { InitialisedList } from '../core/initialise-lists'
import { createImagesContext } from '../assets/createImagesContext'
import { createFilesContext } from '../assets/createFilesContext'
import { getDbFactory, getQueryFactory } from './api'

export function createContext ({
  config,
  lists,
  graphQLSchema,
  graphQLSchemaSudo,
  prismaClient,
}: {
  config: KeystoneConfig
  lists: Record<string, InitialisedList>
  graphQLSchema: GraphQLSchema
  graphQLSchemaSudo: GraphQLSchema
  prismaClient: PrismaClient
}) {
  const dbFactories: Record<string, ReturnType<typeof getDbFactory>> = {}
  for (const [listKey, list] of Object.entries(lists)) {
    dbFactories[listKey] = getDbFactory(list, graphQLSchema)
  }

  const dbFactoriesSudo: Record<string, ReturnType<typeof getDbFactory>> = {}
  for (const [listKey, list] of Object.entries(lists)) {
    dbFactoriesSudo[listKey] = getDbFactory(list, graphQLSchemaSudo)
  }

  const queryFactories: Record<string, ReturnType<typeof getQueryFactory>> = {}
  for (const [listKey, list] of Object.entries(lists)) {
    queryFactories[listKey] = getQueryFactory(list, graphQLSchema)
  }

  const queryFactoriesSudo: Record<string, ReturnType<typeof getQueryFactory>> = {}
  for (const [listKey, list] of Object.entries(lists)) {
    queryFactoriesSudo[listKey] = getQueryFactory(list, graphQLSchemaSudo)
  }

  const images = createImagesContext(config)
  const files = createFilesContext(config)
  const construct = ({
    session,
    sudo,
    req,
    res,
  }: {
    session?: unknown
    sudo: Boolean
    req?: IncomingMessage
    res?: ServerResponse
  }) => {
    const schema = sudo ? graphQLSchemaSudo : graphQLSchema
    const rawGraphQL: KeystoneGraphQLAPI['raw'] = ({ query, variables }) => {
      const source = typeof query === 'string' ? query : print(query)
      return Promise.resolve(
        graphql({
          schema,
          source,
          contextValue: context,
          variableValues: variables,
        }) as ExecutionResult<any>
      )
    }

    const runGraphQL: KeystoneGraphQLAPI['run'] = async ({ query, variables }) => {
      const result = await rawGraphQL({ query, variables })
      if (result.errors?.length) throw result.errors[0]
      return result.data as any
    }

    async function withRequest (newReq: IncomingMessage, newRes?: ServerResponse) {
      const newContext = construct({
        session,
        sudo,
        req: newReq,
        res: newRes,
      })
      return newContext.withSession(await config.session?.get({ context: newContext }) ?? undefined)
    }

    const context: KeystoneContext = {
      db: {},
      query: {},
      graphql: { raw: rawGraphQL, run: runGraphQL, schema },
      prisma: prismaClient,

      sudo: () => construct({ session, sudo: true, req, res }),

      // TODO: deprecated, remove in breaking change
      exitSudo: () => construct({ session, sudo: false, req, res }),

      req,
      res,
      sessionStrategy: config.session,
      ...(session ? { session } : {}),

      withRequest,
      withSession: session => {
        return construct({ session, sudo, req, res })
      },

      images,
      files,

      // TODO: deprecated, remove in breaking change
      gqlNames: (listKey: string) => lists[listKey].graphql.names,

      // TODO: rename __internal ?
      ...(config.experimental?.contextInitialisedLists
        ? {
            experimental: { initialisedLists: lists },
          }
        : {}),
    }

    const _dbFactories = sudo ? dbFactoriesSudo : dbFactories
    const _queryFactories = sudo ? queryFactoriesSudo : queryFactories

    for (const listKey of Object.keys(lists)) {
      context.db[listKey] = _dbFactories[listKey](context)
      context.query[listKey] = _queryFactories[listKey](context)
    }

    return context
  }

  return construct({
    session: undefined,
    sudo: false
  })
}
