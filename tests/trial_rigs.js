require('lodash.combinations');
let _ = require('lodash');

var target_hashrate = 10000

var selected_rigs = []
var selected_rigs_old_method = []
var rigs = [5000, 3500, 2000, 1500, 1000, 1000]

var total_selected_rigs = function(my_selected_rigs){
	var total = 0;

	for (var rig of my_selected_rigs){
		total += parseInt(rig)
	}

	return total
}

let combinations = _.flatMap(rigs, (v, i, a) => _.combinations(a, i + 1));

let best_match = []

for (var combo of combinations){
	if (total_selected_rigs(combo) <= target_hashrate && total_selected_rigs(combo) > total_selected_rigs(best_match))
		best_match = combo
}

console.log(best_match)