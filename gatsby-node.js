const algoliasearch = require('algoliasearch');
const chunk = require('lodash.chunk');
const Activity = require('./activity');

/**
 * give back the same thing as this was called with.
 *
 * @param {any} obj what to keep the same
 */
const identity = obj => obj;

const indexState = {}

/**
 * Fetches all records for the current index from Algolia
 *
 * @param {AlgoliaIndex} index eg. client.initIndex('your_index_name');
 * @param {Array<String>} attributesToRetrieve eg. ['modified', 'slug']
 */
function fetchAlgoliaObjects(index, attributesToRetrieve = ['modified']) {
  return new Promise((resolve, reject) => {
    /* Check if we havn't already fetched this index */
    const state = indexState[index.indexName]
    if (state && state.hits) return resolve(state.hits)

    const browser = index.browseAll('', { attributesToRetrieve });
    const hits = {};

    browser.on('result', (content) => {
      if (Array.isArray(content.hits)) {
        content.hits.forEach(hit => {
          hits[hit.objectID] = hit
        })
      }
    });
    browser.on('end', () => resolve(hits) );
    browser.on('error', (err) => reject(err) );
  });
}

async function getAlgoliaObjects(state, indexToUse, matchFields) {
  if (state.algoliaObjects) return state.algoliaObjects
  if (state._fetchingAlgoliaObjects) return state._fetchingAlgoliaObjects
  else {
    state._fetchingAlgoliaObjects = fetchAlgoliaObjects(indexToUse, matchFields)
    state.algoliaObjects = await state._fetchingAlgoliaObjects
    delete(state._fetchingAlgoliaObjects)
    return state.algoliaObjects
  }
}

exports.onPostBuild = async function(
  { graphql },
  { appId, apiKey, queries, indexName: mainIndexName, chunkSize = 1000, enablePartialUpdates = false, matchFields: mainMatchFields = ['modified'] }
) {
  const activity = new Activity('Algolia Plugin');
  activity.start();

  const client = algoliasearch(appId, apiKey);

  activity.report(`${queries.length} queries to index`);

  const jobs = queries.map(async function doQuery(
    { indexName = mainIndexName, query, transformer = identity, settings, matchFields = mainMatchFields },
    i
  ) {
    if (!query) {
      report.panic(
        `failed to index to Algolia. You did not give "query" to this query`
      );
    }
    if (!Array.isArray(matchFields) || !matchFields.length) {
      return report.panic(
        `failed to index to Algolia. Argument matchFields has to be an array of strings`
      );
    }

    /* Use to keep track of what to remove afterwards */
    if (!indexState[indexName]) indexState[indexName] = {
      index: client.initIndex(indexName),
      checked: {}
    }
    const currentIndexState = indexState[indexName]

    const { index } = currentIndexState;
    /* Use temp index if main index already exists */
    let useTempIndex = false
    const indexToUse = await (async function(_index) {
      if (!enablePartialUpdates) {
        if (useTempIndex = await indexExists(_index)) {
          return client.initIndex(`${indexName}_tmp`);
        }
      }
      return _index
    })(index)

    activity.report(`query ${i}: executing query`);
    const result = await graphql(query);
    if (result.errors) {
      report.panic(`failed to index to Algolia`, result.errors);
    }
    const objects = transformer(result);

    if (objects.length > 0 && !objects[0].objectID) {
      report.panic(
        `failed to index to Algolia. Query results do not have 'objectID' key`
      );
    }

    activity.report(`query ${i}: graphql resulted in ${Object.keys(objects).length} records`);

    let hasChanged = objects;
    if (enablePartialUpdates) {
      activity.report(`query ${i}: starting Partial updates`);

      const algoliaObjects = await getAlgoliaObjects(currentIndexState, indexToUse, matchFields);

      const results = Object.keys(algoliaObjects).length
      activity.report(`query ${i}: found ${results} existing records`);

      if (results) {
        hasChanged = objects.filter(curObj => {
          const ID = curObj.objectID
          const extObj = currentIndexState.checked[ID] = currentIndexState.checked[ID] || algoliaObjects[ID]

          /* The object exists so we don't need to remove it from Algolia */
          delete(algoliaObjects[ID]);

          if (!extObj) return true;

          return !!matchFields.find(field => extObj[field] !== curObj[field]);
        });
      }

      activity.report(`query ${i}: Partial updates – [insert/update: ${hasChanged.length}, total: ${objects.length}]`);
    }

    const chunks = chunk(hasChanged, chunkSize);

    activity.report(`query ${i}: splitting in ${chunks.length} jobs`);

    /* Add changed / new objects */
    const chunkJobs = chunks.map(async function(chunked) {
      const { taskID } = await indexToUse.addObjects(chunked);
      return indexToUse.waitTask(taskID);
    });

    await Promise.all(chunkJobs);

    if (settings) {
      indexToUse.setSettings(settings);
    }

    if (useTempIndex) {
      activity.report(`query ${i}: moving copied index to main index`);
      return moveIndex(client, indexToUse, index);
    }
  });

  try {
    await Promise.all(jobs)

    if (enablePartialUpdates) {
      /* Execute once per index */
      /* This allows multiple queries to overlap */
      const cleanup = Object.keys(indexState).map(async function(indexName) {
        const { index, algoliaObjects } = indexState[indexName];
        if (!algoliaObjects) return
        const toRemove = Object.keys(algoliaObjects);

        if (toRemove.length) {
          activity.report(`deleting ${toRemove.length} object from ${indexName} index`);
          const { taskID } = await index.deleteObjects(toRemove);
          return index.waitTask(taskID);
        }
      })

      await Promise.all(cleanup);
    }
  } catch (err) {
    activity.error(`failed to index to Algolia`, err);
  }
  activity.end();
};

/**
 * Copy the settings, synonyms, and rules of the source index to the target index
 * @param client
 * @param sourceIndex
 * @param targetIndex
 * @return {Promise}
 */
async function scopedCopyIndex(client, sourceIndex, targetIndex) {
  const { taskID } = await client.copyIndex(
    sourceIndex.indexName,
    targetIndex.indexName,
    ['settings', 'synonyms', 'rules']
  );
  return targetIndex.waitTask(taskID);
}

/**
 * moves the source index to the target index
 * @param client
 * @param sourceIndex
 * @param targetIndex
 * @return {Promise}
 */
async function moveIndex(client, sourceIndex, targetIndex) {
  const { taskID } = await client.moveIndex(
    sourceIndex.indexName,
    targetIndex.indexName
  );
  return targetIndex.waitTask(taskID);
}

/**
 * Does an Algolia index exist already
 *
 * @param index
 */
async function indexExists(index) {
  try {
    const { nbHits } = await index.search();
    return nbHits > 0;
  } catch (e) {
    return false;
  }
}
