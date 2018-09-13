var rimraf = require('rimraf');

try {
	rimraf(__dirname + "/../localStorage", function(){})
} catch (e) {}