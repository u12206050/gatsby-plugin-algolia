const algoliasearch = require('algoliasearch');
const chunk = require('lodash.chunk');
const report = require('gatsby-cli/lib/reporter');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * give back the same thing as this was called with.
 *
 * @param {any} obj what to keep the same
 */
const identity = obj => obj;

exports.onPostBuild = async function(
  { graphql },
  { appId, apiKey, queries, indexName: mainIndexName, chunkSize = 1000, enableCache = false }
) {
  const activity = report.activityTimer(`index to Algolia`);
  activity.start();
  const client = algoliasearch(appId, apiKey);

  /* Check hashes and changes */
  const HashFile = path.resolve('./.cache/algolia-index.json')
  let aIndex = {}
  const newIndex = {}
  const indexes = {}
  if (enableCache && fs.existsSync(HashFile)) {
    let rawdata = fs.readFileSync(HashFile);
    aIndex = JSON.parse(rawdata);

    setStatus(activity, `Loaded algolia cache; has ${Object.keys(aIndex).length} indexes`);
  }


  const hashObject = (queryIndex, obj) => {
    // Must have objectID
    const ID = obj.objectID;

    const hash = crypto.createHash(`md5`).update(JSON.stringify(obj)).digest(`hex`);
    const oldHash = aIndex[queryIndex] && aIndex[queryIndex][ID];

    /* Save key and hash of object */
    if (!newIndex[queryIndex]) newIndex[queryIndex] = {};
    newIndex[queryIndex][ID] = hash;

    /* Remove existing hash so we can cleanup (deleted objects) afterwards */
    aIndex[queryIndex] && delete(aIndex[queryIndex][ID]);

    /* Object is new or has changed if */
    return oldHash !== hash;
  }

  setStatus(activity, `${queries.length} queries to index`);

  const jobs = queries.map(async function doQuery(
    { indexName = mainIndexName, query, transformer = identity, settings },
    i
  ) {
    if (!query) {
      report.panic(
        `failed to index to Algolia. You did not give "query" to this query`
      );
    }
    const index = client.initIndex(indexName);
    const mainIndexExists = await indexExists(index);
    const tmpIndex = client.initIndex(`${indexName}_tmp`);
    const indexToUse = mainIndexExists ? tmpIndex : index;
    indexes[indexName] = indexToUse

    if (mainIndexExists) {
      setStatus(activity, `query ${i}: copying existing index`);
      await scopedCopyIndex(client, index, tmpIndex);
    }

    setStatus(activity, `query ${i}: executing query`);
    const result = await graphql(query);
    if (result.errors) {
      report.panic(`failed to index to Algolia`, result.errors);
    }
    const objects = transformer(result);

    setStatus(activity, `query ${i}: Checking what has changed`);

    if (objects.length > 0 && !objects[0].objectID) {
      report.panic(
        `failed to index to Algolia. Query results do not have 'objectID' key`
      );
    }

    let hasChanged = objects;
    if (enableCache) {
      hasChanged = objects.filter(obj => hashObject(`${indexName}-${i}`, obj));
      setStatus(activity, `query ${i}: Caching Status [Changed: ${hasChanged.length}, Total: ${objects.length}]`);
    }

    const chunks = chunk(hasChanged, chunkSize);

    setStatus(activity, `query ${i}: splitting in ${chunks.length} jobs`);

    /* Add changed / new objects */
    const chunkJobs = chunks.map(async function(chunked) {
      const { taskID } = await indexToUse.addObjects(chunked);
      return indexToUse.waitTask(taskID);
    });

    if (enableCache) {
      /* Remove deleted objects */
      const isRemoved = aIndex[i] && Object.keys(aIndex[i]);
      const removeOldObjects = async function(objectIds) {
        const { taskID } = await indexToUse.deleteObjects(objectIds);
        return indexToUse.waitTask(taskID);
      }

      if (isRemoved && isRemoved.length) {
        setStatus(activity, `query ${i}: Removed ${isRemoved.length}`);
        chunkJobs.push(removeOldObjects(isRemoved));
      }
    }

    await Promise.all(chunkJobs);

    if (settings) {
      indexToUse.setSettings(settings);
    }

    if (mainIndexExists) {
      setStatus(activity, `query ${i}: moving copied index to main index`);
      return moveIndex(client, tmpIndex, index);
    }
  });

  try {
    await Promise.all(jobs);
    if (enableCache) {
      /* Save hashes back to file */
      fs.writeFileSync(HashFile, JSON.stringify(newIndex));
    }
  } catch (err) {
    report.panic(`failed to index to Algolia`, err);
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

/**
 * Hotfix the Gatsby reporter to allow setting status (not supported everywhere)
 *
 * @param {Object} activity reporter
 * @param {String} status status to report
 */
function setStatus(activity, status) {
  if (activity && activity.setStatus) {
    activity.setStatus(status);
  } else {
    console.log('Algolia:', status);
  }
}
