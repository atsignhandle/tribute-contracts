// Whole-script strict mode syntax
"use strict";

/**
MIT License

Copyright (c) 2020 Openlaw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
 */

const { entryDao, entryBank } = require("./access-control-util");
const { adaptersIdsMap, extensionsIdsMap } = require("./dao-ids-util");
const { UNITS, LOOT, sha3, embedConfigs } = require("./contract-util.js");
const { ContractType } = require("../migrations/configs/contracts.config");

/**
 * Deploys a contract based on the contract name defined in the config parameter.
 * If the contract is not found in the options object the deployment reverts with an error.
 */
const deployContract = ({ config, options }) => {
  const contract = options[config.name];
  if (!contract)
    throw new Error(`Contract ${config.name} not found in environment options`);

  if (config.deploymentArgs && config.deploymentArgs.length > 0) {
    const args = config.deploymentArgs.map((argName) => {
      const arg = options[argName];
      if (arg !== null && arg !== undefined) return arg;
      throw new Error(
        `Missing deployment argument <${argName}> for ${config.name}`
      );
    });
    return options.deployFunction(contract, args);
  }
  return options.deployFunction(contract);
};

/**
 * Deploys all the contracts defined with Factory type.
 * The contracts must be enabled in the migrations/configs/*.config.ts,
 * and should not be skipped in the auto deploy process.
 * The factory contract must be provided in the options object.
 * If the contract is not found in the options object the deployment reverts with an error.
 */
const createFactories = async ({ options }) => {
  const factories = {};
  await Object.values(options.contractConfigs)
    .filter((config) => config.type === ContractType.Factory)
    .filter((config) => config.enabled)
    .filter((config) => !config.skipAutoDeploy)
    .reduce((p, config) => {
      return p
        .then((_) => {
          const factoryContract = options[config.name];
          if (!factoryContract)
            throw new Error(`Missing factory contract ${config.name}`);

          const extensionConfig = options.contractConfigs.find(
            (c) => c.id === config.generatesExtensionId
          );
          if (!extensionConfig)
            throw new Error(
              `Missing extension config ${config.generatesExtensionId}`
            );

          const extensionContract = options[extensionConfig.name];
          if (!extensionContract)
            throw new Error(
              `Missing extension contract ${extensionConfig.name}`
            );

          return options
            .deployFunction(factoryContract, [extensionContract])
            .catch((e) => {
              console.error(`Failed factory deployment [${config.name}].`, e);
              throw e;
            });
        })
        .then((factory) => (factories[factory.configs.alias] = factory));
    }, Promise.resolve());

  return factories;
};

/**
 * Deploys all the contracts defined with Extension type.
 * The contracts must be enabled in the migrations/configs/*.config.ts,
 * and should not be skipped in the auto deploy process.
 * The extension contract must be provided in the options object.
 * If the contract is not found in the options object the deployment reverts with an error.
 * In order to deploy the extension it uses the factory contract of each extension,
 * so the factories must be deployed first.
 */
const createExtensions = async ({ dao, factories, options }) => {
  const extensions = {};

  const createExtension = async ({ dao, factory, options }) => {
    const factoryConfigs = factory.configs;
    const extensionConfigs = options.contractConfigs.find(
      (c) => c.id === factoryConfigs.generatesExtensionId
    );
    if (!extensionConfigs)
      throw new Error(
        `Missing extension configuration <generatesExtensionId> for in ${factoryConfigs.name} configs`
      );

    if (
      factoryConfigs.deploymentArgs &&
      factoryConfigs.deploymentArgs.length > 0
    ) {
      const args = factoryConfigs.deploymentArgs.map((argName) => {
        const arg = options[argName];
        if (arg !== null && arg !== undefined) return arg;
        throw new Error(
          `Missing deployment argument <${argName}> in ${factoryConfigs.name}.create`
        );
      });
      await factory.create(...args);
    } else {
      await factory.create();
    }

    const extensionAddress = await factory.getExtensionAddress(
      options.daoAddress
    );
    const extensionContract = options[extensionConfigs.name];
    if (!extensionContract)
      throw new Error(
        `Extension contract not found for ${extensionConfigs.name}`
      );

    const newExtension = embedConfigs(
      await extensionContract.at(extensionAddress),
      extensionContract.contractName,
      options.contractConfigs
    );

    if (!newExtension || !newExtension.configs)
      throw new Error(
        `Unable to embed extension configs for ${extensionConfigs.name}`
      );

    await dao.addExtension(
      sha3(newExtension.configs.id),
      newExtension.address,
      options.owner,
      {
        from: options.owner,
      }
    );

    return newExtension;
  };

  await Object.values(factories).reduce(
    (p, factory) =>
      p
        .then(() =>
          createExtension({
            dao,
            factory,
            options,
          })
        )
        .then((extension) => {
          extensions[extension.configs.alias] = extension;
        })
        .catch((e) => {
          console.error(
            `Failed extension deployment ${factory.configs.name}`,
            e
          );
          throw e;
        }),
    Promise.resolve()
  );
  return extensions;
};

/**
 * Deploys all the contracts defined with Adapter type.
 * The contracts must be enabled in the migrations/configs/*.config.ts,
 * and should not be skipped in the auto deploy process.
 * The adapter contract must be provided in the options object.
 * If the contract is not found in the options object the deployment reverts with an error.
 */
const createAdapters = async ({ options }) => {
  const adapters = {};
  await Object.values(options.contractConfigs)
    .filter((config) => config.type === ContractType.Adapter)
    .filter((config) => config.enabled)
    .filter((config) => !config.skipAutoDeploy)
    .reduce(
      (p, config) =>
        p
          .then(() => deployContract({ config, options }))
          .then((adapter) => {
            adapters[adapter.configs.alias] = adapter;
          })
          .catch((e) => {
            console.error(`Error while creating adapter ${config.name}.`, e);
            throw e;
          }),
      Promise.resolve()
    );

  return adapters;
};

/**
 * Deploys all the contracts defined in the migrations/configs/*.config.ts.
 * The contracts must be enabled in the migrations/configs/*.config.ts,
 * and should not be skipped in the auto deploy process.
 * Each one of the contracts must be provided in the options object.
 * If the contract is not found in the options object the deployment reverts with an error.
 * It also configures the DAO with the proper access, and configuration parameters for all
 * adapters and extensions.
 *
 * The Offchain voting is deployed only if it is required via options.offchainVoting parameter.
 *
 * All the deployed contracts will be returned in a map with the aliases defined in the
 * migrations/configs/*.config.ts.
 */
const deployDao = async (options) => {
  const { dao, daoFactory } = await cloneDao({
    ...options,
    name: options.daoName || "test-dao",
  });

  options = {
    ...options,
    daoAddress: dao.address,
    unitTokenToMint: UNITS,
    lootTokenToMint: LOOT,
  };

  const factories = await createFactories({ options });
  const extensions = await createExtensions({ dao, factories, options });
  const adapters = await createAdapters({
    dao,
    daoFactory,
    extensions,
    options,
  });

  await configureDao({
    owner: options.owner,
    dao,
    daoFactory,
    extensions,
    adapters,
    options,
  });

  const votingHelpers = await configureOffchainVoting({
    ...options,
    dao,
    daoFactory,
    extensions,
  });

  // If the offchain contract was created, set it to the adapters map using the alias
  if (votingHelpers.offchainVoting) {
    adapters[votingHelpers.offchainVoting.configs.alias] =
      votingHelpers.offchainVoting;
  }

  // deploy utility contracts
  const utilContracts = await createUtilContracts({ options });

  // deploy test token contracts for testing convenience
  const testContracts = await createTestContracts({ options });

  if (options.finalize) {
    await dao.finalizeDao({ from: options.owner });
  }

  return {
    dao: dao,
    adapters: adapters,
    extensions: extensions,
    testContracts: testContracts,
    utilContracts: utilContracts,
    votingHelpers: votingHelpers,
    factories: { ...factories, daoFactory },
  };
};

const cloneDao = async ({
  owner,
  creator,
  deployFunction,
  DaoRegistry,
  DaoFactory,
  name,
}) => {
  let daoFactory = await deployFunction(DaoFactory, [DaoRegistry], owner);

  await daoFactory.createDao(name, creator ? creator : owner, { from: owner });

  let _address = await daoFactory.getDaoAddress(name);
  let newDao = await DaoRegistry.at(_address);
  return { dao: newDao, daoFactory, daoName: name };
};

const configureDao = async ({
  owner,
  dao,
  daoFactory,
  extensions,
  adapters,
  options,
}) => {
  const configureAdaptersWithDAOAccess = async () => {
    const adaptersWithAccess = Object.values(adapters)
      .filter((a) => a.configs.enabled)
      .filter((a) => !a.configs.skipAutoDeploy)
      .filter((a) => a.configs.acls.dao)
      .reduce((withAccess, a) => {
        const configs = a.configs;
        withAccess.push(entryDao(configs.id, a.address, configs.acls));
        return withAccess;
      }, []);

    // If an extension needs access to other extension,
    // the extension needs to be added as an adapter to the DAO,
    // but without any ACL flag enabled.
    const contractsWithAccess = Object.values(extensions)
      .filter((e) => e.configs.enabled)
      .filter((a) => !a.configs.skipAutoDeploy)
      .filter((e) => Object.keys(e.configs.acls.extensions).length > 0)
      .reduce((withAccess, e) => {
        const configs = e.configs;
        const v = entryDao(configs.id, e.address, configs.acls);
        withAccess.push(v);
        return withAccess;
      }, adaptersWithAccess);

    await daoFactory.addAdapters(dao.address, contractsWithAccess, {
      from: owner,
    });
  };

  const configureAdaptersWithDAOParameters = async () => {
    const readConfigValue = (configName, contractName) => {
      // 1st check for configs that are using extension addresses
      if (Object.values(extensionsIdsMap).includes(configName)) {
        const extension = Object.values(extensions).find(
          (e) => e.configs.id === configName
        );
        if (!extension || !extension.address)
          throw new Error(
            `Error while configuring dao parameter [${configName}] for ${contractName}`
          );
        return extension.address;
      }
      // 2nd lookup for configs in the options object
      const configValue = options[configName];
      if (!configValue)
        throw new Error(
          `Error while configuring dao parameter [${configName}] for ${contractName}`
        );
      return configValue;
    };

    await Object.values(adapters)
      .filter((a) => a.configs.enabled)
      .filter((a) => !a.configs.skipAutoDeploy)
      .filter((a) => a.configs.daoConfigs && a.configs.daoConfigs.length > 0)
      .reduce((p, adapter) => {
        const contractConfigs = adapter.configs;
        return p
          .then(() =>
            contractConfigs.daoConfigs.reduce(
              (q, configEntry) =>
                q.then(() => {
                  const configValues = configEntry.map((configName) =>
                    readConfigValue(configName, contractConfigs.name)
                  );
                  return adapter
                    .configureDao(...configValues, {
                      from: options.owner,
                    })
                    .catch((e) => {
                      console.error(e);
                      throw e;
                    });
                }),
              Promise.resolve()
            )
          )
          .catch((e) => {
            console.error(
              `Error while configuring dao with contract ${contractConfigs.name}`,
              e
            );
            throw e;
          });
      }, Promise.resolve());
  };

  const configureExtensionAccess = async (contracts, extension) => {
    const withAccess = Object.values(contracts).reduce((accessRequired, c) => {
      const configs = c.configs;
      accessRequired.push(
        extension.configs.buildAclFlag(c.address, configs.acls)
      );
      return accessRequired;
    }, []);

    if (withAccess.length > 0)
      await daoFactory.configureExtension(
        dao.address,
        extension.address,
        withAccess,
        { from: owner }
      );
  };

  /**
   * Configures all the adapters that need access to the DAO and each enabled extension
   */
  const configureAdapters = async () => {
    await configureAdaptersWithDAOAccess();
    await configureAdaptersWithDAOParameters();
    await Object.values(extensions)
      .filter((targetExtension) => targetExtension.configs.enabled)
      .filter((targetExtension) => !targetExtension.configs.skipAutoDeploy)
      .reduce((p, targetExtension) => {
        // Filters the enabled adapters that have access to the targetExtension
        const contracts = Object.values(adapters)
          .filter((a) => a.configs.enabled)
          .filter((a) => !a.configs.skipAutoDeploy)
          .filter((a) =>
            // The adapters must have at least 1 ACL flag defined to access the targetExtension
            Object.keys(a.configs.acls.extensions).some(
              (extId) => extId === targetExtension.configs.id
            )
          );

        return p
          .then(() => configureExtensionAccess(contracts, targetExtension))
          .catch((e) => {
            console.error(
              `Error while configuring adapters access to extension ${extensions.configs.name}`,
              e
            );
            throw e;
          });
      }, Promise.resolve());
  };

  /**
   * Configures all the extensions that need access to
   * other enabled extensions
   */
  const configureExtensions = async () => {
    await Object.values(extensions)
      .filter((targetExtension) => targetExtension.configs.enabled)
      .reduce((p, targetExtension) => {
        // Filters the enabled extensions that have access to the targetExtension
        const contracts = Object.values(extensions)
          .filter((e) => e.configs.enabled)
          .filter((e) => e.configs.id !== targetExtension.configs.id)
          .filter((e) =>
            // The other extensions must have at least 1 ACL flag defined to access the targetExtension
            Object.keys(e.configs.acls.extensions).some(
              (extId) => extId === targetExtension.configs.id
            )
          );

        return p
          .then(() => configureExtensionAccess(contracts, targetExtension))
          .catch((e) => {
            console.error(
              `Error while configuring extensions access to extension ${targetExtension.configs.name}`
            );
            throw e;
          });
      }, Promise.resolve());
  };

  await configureAdapters();
  await configureExtensions();
};

const createUtilContracts = async ({ options }) => {
  const utilContracts = {};

  await Object.values(options.contractConfigs)
    .filter((config) => config.type === ContractType.Util)
    .filter((config) => config.enabled)
    .filter((config) => !config.skipAutoDeploy)
    .reduce(
      (p, config) =>
        p
          .then(() => deployContract({ config, options }))
          .then((utilContract) => {
            utilContracts[utilContract.configs.alias] = utilContract;
          })
          .catch((e) => {
            console.error(
              `Error while creating util contract ${config.name}`,
              e
            );
            throw e;
          }),
      Promise.resolve()
    );
  return utilContracts;
};

const createTestContracts = async ({ options }) => {
  const testContracts = {};

  if (!options.deployTestTokens) return testContracts;

  await Object.values(options.contractConfigs)
    .filter((config) => config.type === ContractType.Test)
    .filter((config) => config.enabled)
    .filter((config) => !config.skipAutoDeploy)
    .reduce(
      (p, config) =>
        p
          .then(() => deployContract({ config, options }))
          .then((testContract) => {
            testContracts[testContract.configs.alias] = testContract;
          })
          .catch((e) => {
            console.error(
              `Error while creating test contract ${config.name}`,
              e
            );
            throw e;
          }),
      Promise.resolve()
    );
  return testContracts;
};

const configureOffchainVoting = async ({
  dao,
  daoFactory,
  offchainVoting,
  chainId,
  owner,
  offchainAdmin,
  votingPeriod,
  gracePeriod,
  SnapshotProposalContract,
  KickBadReporterAdapter,
  OffchainVotingContract,
  OffchainVotingHashContract,
  deployFunction,
  extensions,
}) => {
  const votingHelpers = {
    snapshotProposalContract: null,
    handleBadReporterAdapter: null,
    offchainVoting: null,
  };

  // Offchain voting is disabled
  if (!offchainVoting) return votingHelpers;

  const currentVotingAdapterAddress = await dao.getAdapterAddress(
    sha3(adaptersIdsMap.VOTING_ADAPTER)
  );

  const snapshotProposalContract = await deployFunction(
    SnapshotProposalContract,
    [chainId]
  );

  const offchainVotingHashContract = await deployFunction(
    OffchainVotingHashContract,
    [snapshotProposalContract.address]
  );

  const handleBadReporterAdapter = await deployFunction(KickBadReporterAdapter);
  const offchainVotingContract = await deployFunction(OffchainVotingContract, [
    currentVotingAdapterAddress,
    offchainVotingHashContract.address,
    snapshotProposalContract.address,
    handleBadReporterAdapter.address,
    offchainAdmin,
  ]);

  await daoFactory.updateAdapter(
    dao.address,
    entryDao(
      offchainVotingContract.configs.id,
      offchainVotingContract.address,
      offchainVotingContract.configs.acls
    ),
    {
      from: owner,
    }
  );

  await dao.setAclToExtensionForAdapter(
    extensions.bankExt.address,
    offchainVotingContract.address,
    entryBank(
      offchainVotingContract.address,
      offchainVotingContract.configs.acls
    ).flags,
    { from: owner }
  );

  await offchainVotingContract.configureDao(
    dao.address,
    votingPeriod,
    gracePeriod,
    10,
    { from: owner }
  );

  votingHelpers.offchainVoting = offchainVotingContract;
  votingHelpers.handleBadReporterAdapter = handleBadReporterAdapter;
  votingHelpers.snapshotProposalContract = snapshotProposalContract;

  return votingHelpers;
};

const networks = [
  {
    name: "ganache",
    chainId: 1337,
  },
  {
    name: "rinkeby",
    chainId: 4,
  },
  {
    name: "rinkeby-fork",
    chainId: 4,
  },
  {
    name: "goerli",
    chainId: 5,
  },
  {
    name: "test",
    chainId: 1,
  },
  {
    name: "coverage",
    chainId: 1,
  },
  {
    name: "mainnet",
    chainId: 1,
  },
  {
    name: "harmony",
    chainId: 1666600000,
  },
  {
    name: "harmonytest",
    chainId: 1666700000,
  },
];

const getNetworkDetails = (name) => {
  return networks.find((n) => n.name === name);
};

module.exports = {
  createFactories,
  createExtensions,
  createAdapters,
  deployDao,
  cloneDao,
  getNetworkDetails,
};
