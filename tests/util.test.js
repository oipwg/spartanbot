const { selectBestCombination } = require("../src/util")

describe("selectBestCombination", () => {
	test("selectBest hashrate", () => {
		var target_hashrate = 10000
		var rigs = [{ hashrate: 2000 }, { hashrate: 1000 }, { hashrate: 1500 }, { hashrate: 5000 }, { hashrate: 3000 }]
		
		var getHashrateFromRig = function(rig){
			return rig.hashrate
		}

		expect(selectBestCombination(rigs, target_hashrate, getHashrateFromRig)).toEqual([{"hashrate": 2000}, {"hashrate": 5000}, {"hashrate": 3000}])
	})
	
	test("selectBest price", () => {
		var target_cost = 10
		var rigs = [{ price: 1 }, { price: 7 }, { price: 4 }, { price: 3 }, { price: 2 }]
		
		var getPriceFromRig = function(rig){
			return rig.price
		}

		expect(selectBestCombination(rigs, target_cost, getPriceFromRig)).toEqual([{"price": 1}, {"price": 7}, {"price": 2}])
	})
})