const chalk = require("chalk");
const fs = require("fs");
const fsp = require('fs/promises');
const luxon = require("luxon");
const path = require("path");
const bent = require("bent");
const YAML = require('yaml');
// const escape = require("html-escaper").escape;

const shared = require("./shared");
const settings = require("./settings");

const getBuffer = bent('buffer');

async function writeFilesPromise(posts, config) {
  await writeMarkdownFilesPromise(posts, config);
  await writeCommentFilesPromise(posts, config);
  await writeImageFilesPromise(posts, config);
}

async function processPayloadsPromise(payloads, loadFunc) {
  const promises = payloads.map(
    (payload) =>
      new Promise((resolve, reject) => {
        setTimeout(async () => {
          try {
            const data = await loadFunc(payload.item);
            await writeFile(payload.destinationPath, data);
            console.log(chalk.green("[OK]") + " " + payload.name);
            resolve();
          } catch (ex) {
            console.log(
              chalk.red("[FAILED]") +
                " " +
                payload.name +
                " " +
                chalk.red("(" + ex.toString() + ")")
            );
            reject();
          }
        }, payload.delay);
      })
  );

  const results = await Promise.allSettled(promises);
  const failedCount = results.filter(
    (result) => result.status === "rejected"
  ).length;
  if (failedCount === 0) {
    console.log("Done, got them all!");
  } else {
    console.log("Done, but with " + chalk.red(failedCount + " failed") + ".");
  }
}

async function writeFile(destinationPath, data) {
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.promises.writeFile(destinationPath, data);
}

async function writeCommentFilesPromise(posts, config) {
  let skipCount = 0;
  let regenerateCount = 0;
  let delay = 0;
  const payloads = posts.flatMap((post) => {
    return post.comments.flatMap((comment) => {
      const destinationPath = getCommentPath(comment, post, config);
      if (checkFile(destinationPath)) {
        if (config.regenerateMarkdown) {
          regenerateCount++;
        } else {
          skipCount++;
          return [];
        }
      }

      const payload = {
        item: comment,
        name: path.basename(destinationPath),
        destinationPath,
        delay,
      };
      delay += settings.markdown_file_write_delay;
      return [payload];
    });
  });

  const remainingCount = payloads.length;
  if (remainingCount + skipCount === 0) {
    console.log("\nNo comments to save...");
  } else {
    if (config.regenerateMarkdown) {
      console.log(
        `\nSaving ${remainingCount} comments (${regenerateCount} will be rewritten)...`
      );
    } else {
      console.log(
        `\nSaving ${remainingCount} comments (${skipCount} already exist)...`
      );
    }
    await processPayloadsPromise(payloads, loadCommentFilePromise);
  }
}

async function writeMarkdownFilesPromise(posts, config) {
  // package up posts into payloads
  let skipCount = 0;
  let regenerateCount = 0;
  let delay = 0;
  const payloads = posts.flatMap((post) => {
    const destinationPath = getPostPath(post, config);
    if (checkFile(destinationPath)) {
      if (config.regenerateMarkdown) {
        regenerateCount++;
      } else {
        skipCount++;
        return [];
      }
    }

    const payload = {
      item: post,
      name:
      (config.includeOtherTypes ? post.meta.type + " - " : "") +
        post.meta.slug,
      destinationPath,
      delay,
    };
    delay += settings.markdown_file_write_delay;
    return [payload];
  });

  const remainingCount = payloads.length;
  if (remainingCount + skipCount === 0) {
    console.log("\nNo posts to save...");
  } else {
    if (config.regenerateMarkdown) {
      console.log(
        `\nSaving ${remainingCount} posts (${regenerateCount} will be rewritten)...`
      );
    } else {
      console.log(
        `\nSaving ${remainingCount} posts (${skipCount} already exist)...`
      );
    }
    await processPayloadsPromise(payloads, (post) => loadMarkdownFilePromise(post, config));
  }
}

async function loadCommentFilePromise(comment) {
  comment.message = comment.message.replaceAll('\r', '');
  // comment.message = comment.message.replaceAll('\n', '<br>');
  // comment.message = escape(comment.message);
  return YAML.stringify(comment);
}

async function loadMarkdownFilePromise(post, config) {
  let output = "---\n";

  Object.entries(post.frontmatter).forEach(([key, value]) => {
    if (config.frontmatterExclude.includes(key)) {
      return;
    }

    let outputValue;
    if (Array.isArray(value)) {
      if (value.length > 0) {
        // array of one or more strings
        outputValue = value.reduce(
          (list, item) => `${list}\n  - "${item}"`,
          ""
        );
      }
    } else {
      // single string value
      const escapedValue = (value || "").replace(/"/g, '\\"');
      outputValue = `"${escapedValue}"`;
    }

    if (outputValue !== undefined) {
      output += `${key}: ${outputValue}\n`;
    }
  });

  output += `---\n\n${post.content}\n`;
  return output;
}

async function writeImageFilesPromise(posts, config) {
  // collect image data from all posts into a single flattened array of payloads
  let skipCount = 0;
  let delay = 0;
  const payloads = posts.flatMap((post) => {
    const postPath = getPostPath(post, config);
    const imagesDir = path.join(path.dirname(postPath), "images");
    return post.meta.imageUrls.flatMap((imageUrl) => {
      const filename = shared.getFilenameFromUrl(imageUrl);
      const destinationPath = path.join(imagesDir, filename);
      if (checkFile(destinationPath)) {
        // already exists, don't need to save again
        skipCount++;
        return [];
      } else {
        if (config.imagesFromFolder.length != 0) {
          const localPath = urlToLocal(imageUrl, config.imagesFromFolder);
          if (checkFile(localPath)) {
            imageUrl = localPath;
          } else {
            throw `Local path to ${filename} doest not exists (${localPath})`
          }
        }
        const payload = {
          item: imageUrl,
          name: filename,
          destinationPath,
          delay,
        };
        //console.log(filename);
        delay += settings.image_file_request_delay;
        return [payload];
      }
    });
  });

  const remainingCount = payloads.length;
  if (remainingCount + skipCount === 0) {
    console.log("\nNo images to download and save...");
  } else {
    console.log(
      `\nDownloading and saving ${remainingCount} images (${skipCount} already exist)...`
    );

    await processPayloadsPromise(payloads, config.imagesFromFolder ? loadImageFilePromiseLocal : loadImageFilePromiseUrl);
  }
}

async function loadImageFilePromiseUrl(imageUrl) {
  // only encode the URL if it doesn't already have encoded characters
  const url = /%[\da-f]{2}/i.test(imageUrl) ? imageUrl : encodeURI(imageUrl);

  return await getBuffer(url);
}

async function loadImageFilePromiseLocal(imagePath) {
  return await fsp.readFile(imagePath);
}

function getBasePath(post, config) {
  const pathSegments = [];

  const dt = luxon.DateTime.fromISO(post.frontmatter.date);

  // create segment for post type if we're dealing with more than just "post"
  if (config.includeOtherTypes) {
    pathSegments.push(post.meta.type);
  }

  if (config.yearFolders) {
    pathSegments.push(dt.toFormat("yyyy"));
  }

  if (config.monthFolders) {
    pathSegments.push(dt.toFormat("LL"));
  }

  if (config.frontmatterFolders) {
    var seg = '(post.frontmatter.' + config.frontmatterFolders + ')';
    seg = eval(seg);
    if (seg != undefined)
      pathSegments.push(seg);
  }

  // create slug fragment, possibly date prefixed
  let slugFragment = post.meta.slug;
  if (config.prefixDate) {
    slugFragment = dt.toFormat("yyyy-LL-dd") + "-" + slugFragment;
  }
  pathSegments.push(slugFragment);

  return pathSegments;
}

function getPostPath(post, config) {
  // start with base output dir
  const pathSegments = [config.output, ...getBasePath(post, config)];

  // use slug fragment as folder or filename as specified
  if (config.postFolders) {
    pathSegments.push("index.md");
  } else {
    pathSegments.push(".md");
  }

  return path.join(...pathSegments);
}

function getCommentPath(comment, post, config) {
  const pathSegments = [config.outputComments, ...getBasePath(post, config)];

  const dt = luxon.DateTime.fromISO(comment.date);
  pathSegments.push(`comment-${dt.toMillis()}.yml`);

  return path.join(...pathSegments);
}

function checkFile(path) {
  return fs.existsSync(path);
}

function urlToLocal(imageUrl, folder) {
  let pathSegments = [];
  for (elem of imageUrl.split(path.sep).reverse()) {
    if (elem == "uploads") break;
    pathSegments.push(elem);
  }
  pathSegments.push(folder);
  const localPath = path.resolve(path.join(...pathSegments.reverse()));
  return localPath;
}

exports.writeFilesPromise = writeFilesPromise;
exports.checkFile = checkFile;
exports.urlToLocal = urlToLocal;
