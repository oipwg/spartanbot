import RentalProvider from './RentalProvider'
import MiningRigRentals from 'miningrigrentals-api-v2'
import {selectBestCombination} from "../util";

/**
 * A Rental Provider for MiningRigRentals
 */
class MRRProvider extends RentalProvider {
	/**
	 * Create a new MRR Provider
	 * @param  {Object} settings - Settings for the RentalProvider
	 * @param {String} settings.api_key - The API Key for the Rental Provider
	 * @param {String} settings.api_secret - The API Secret for the Rental Provider
	 * @param {String} settings.name - Alias/arbitrary name for the provider
	 * @param {String} [settings.uid] - The unique identifier for this Rental Provider
	 * @return {MRRProvider}
	 */
	constructor(settings){
		super(settings)

		this.api = new MiningRigRentals({key: this.api_key, secret: this.api_secret})
	}

	/**
	 * Get the "type" of this RentalProvider
	 * @return {String} Returns "MiningRigRentals"
	 * @static
	 */
	static getType(){
		return "MiningRigRentals"
	}

	/**
	 * Test to make sure the API key and secret are correct
	 * @return {Promise} Returns a Promise that will resolve upon success, and reject on failure
	 */
	async testAuthorization(){
		try {
			let profile = await this.api.whoami();
			return !!(profile.success && profile.data && profile.data.authed);
		} catch (err) {
			throw new Error(err)
		}
	}

	/**
	 * Get MiningRigRentals Profile ID (needed to rent rigs)
	 * @returns {Promise<number>} - the id of the first data object
	 */
	async getProfileID() {
		let profile;
		try {
			profile = await this.api.getPoolProfiles();
		} catch (err) {
			throw new Error(`error getting profile data: ${err}`)
		}
		if (profile.data) {
			//ToDo: be able to pick a pool profile to use
			return Number(profile.data[0].id)
		}
	}
	/**
	 * Creates a pool and adds it to a newly created pool profile
	 * @param {Object} options
	 * @param {string} options.profileName - Name of the profile
	 * @param {string} options.algo - Algorithm ('scrypt', 'x11', etc)
	 * @param {string} options.name - Name to identify the pool with
	 * @param {string} options.host - Pool host, the part after stratum+tcp://
	 * @param {number} options.port - Pool port, the part after the : in most pool host strings
	 * @param {string} options.user - Your workname
	 * @param {number} options.priority - 0-4
	 * @param {string} [options.pass] - Worker password
	 * @param {string} [options.notes] - Additional notes to help identify the pool for you
	 * @returns {Promise<Object>} - returns an object with the profileID and poolid on success
	 */
	async createPool(options) {
		let poolProfile;
		try {
			let response = await this.api.createPoolProfile(options.profileName, options.algo)
			if (response.success) {
				poolProfile = response.data.id
			}
		} catch (err) {
			throw new Error(`Could not create Pool Profile \n ${err}`)
		}
		let pool;
		let poolParams = {};
		for (let opt in options) {
			if (opt !== 'profileName') {
				if (opt === 'algo') {
					poolParams.type = options[opt]
				}
				poolParams[opt] = options[opt]
			}
		}
		try {
			let response = await this.api.createPool(poolParams)
			if (response.success) {
				pool = response.data.id
			}
		} catch (err) {
			throw new Error(`Could not create pool \n ${err}`)
		}

		let addPoolToProfileOptions = {
			profileID: poolProfile,
			poolid: pool,
			priority: options.priority,
			algo: options.algo,
			name: options.name
		};

		let success;
		try {
			let response = await this.api.addPoolToProfile(addPoolToProfileOptions)
			if (response.success) {
				success = response.data
			}
		} catch (err) {
			throw new Error(`Failed to add pool: ${pool} to profile: ${poolProfile} \n ${err}`)
		}
		let returnObject
		if (success.success) {
			returnObject = {
				profileID: success.id,
				poolid: pool,
				success: true,
				message: success.message
			}
		} else {
			returnObject = success
		}
		return returnObject
	}
	/**
	 * Get the rigs needed to fulfill rental requirements
	 * @param {number} hashrate - in megahertz(mh)
	 * @param {number} duration - in hours
	 * @returns {Promise<Array.<Object>>}
	 */
	async getRigsToRent(hashrate, duration) {
		//get profileID
		let profileID
		try {
			profileID =  await this.getProfileID()
		} catch (err) {
			throw new Error(`Could not fetch profile ID \n ${err}`)
		}

		let rigOpts = {
			type: 'scrypt',
			minhours: {
				max: duration
			}
		}
		let rigsRequest;
		try {
			rigsRequest = await this.api.getRigs(rigOpts)
		} catch (err) {
			throw new Error(`Could not fetch rig list \n ${err}`)
		}
		let available_rigs = [];
		if (rigsRequest.success && rigsRequest.data) {
			if (rigsRequest.data.records.length === 0) {
				throw new Error(`No rigs found`)
			}
			let newRPIrigs = [], allOtherRigs = [];
			for (let rig of rigsRequest.data.records) {
				if (rig.rpi === 'new') {
					newRPIrigs.push(rig)
				} else {allOtherRigs.push(rig)}
			}
			allOtherRigs.sort((a,b) => {
				return (b.rpi - a.rpi)
			});
			available_rigs = newRPIrigs.concat(allOtherRigs)
		}

		if (hashrate <= 10000) {
			const calculateHashpower = (rigs) => {
				let total = 0;
				for (let rig of rigs) {
					total += rig.hashrate
				}
				return total
			}
			let filteredRigs = [];
			for (let rig of available_rigs) {
				if (calculateHashpower(filteredRigs) <= (1.1 * hashrate)) {
					filteredRigs.push({
						rental_info: {
							rig: parseInt(rig.id),
							length: duration,
							profile: parseInt(profileID)
						},
						hashrate: rig.hashrate.advertised.hash,
						btc_price: parseFloat(rig.price.BTC.hour) * duration
					})
				} else {break}
			}
			return selectBestCombination(filteredRigs, hashrate, rig => rig.hashrate)
		}

		let rigs_to_rent = [], hashpower = 0;
		for (let rig of available_rigs) {
			let rig_hashrate = rig.hashrate.advertised.hash
			if ((hashpower + rig_hashrate) <= hashrate) {
				hashpower += rig_hashrate

				rigs_to_rent.push({
					rental_info: {
						rig: parseInt(rig.id),
						length: duration,
						profile: parseInt(profileID)
					},
					hashrate: rig_hashrate,
					btc_price: parseFloat(rig.price.BTC.hour) * duration
				})
			}
		}
		return rigs_to_rent
	}
	/**
	 * Get all pools, a single pool by ID, or multiple pools by their IDs
	 * @param {(number|Array.<number>)} [ids] - can be a single pool id or multiple pool ids. If no ids are passed, will fetch all pools
 	 * @returns {Promise<Object>}
	 */
	async getPools(ids) {
		if (!ids) {
			try {
				return await this.api.getPools()
			} catch (err) {
				throw new Error(`Could not fetch pools \n ${err}`)
			}
		} else {
			try {
				return await this.api.getPoolsByID(ids)
			} catch (err) {
				throw new Error(`Could not fetch pools \n ${err}`)
			}
		}
	}

	/**
	 * Get all pool profiles, a single pool profile by ID, or multiple pool profiles by their IDs
	 * @param {(number|Array.<number>)} [ids] - can be a single pool id or multiple pool ids. If no ids are passed, will fetch all pools
	 * @returns {Promise<Object>}
	 */
	async getPoolProfiles(ids) {
		if (!ids) {
			try {
				return await this.api.getPoolProfiles()
			} catch (err) {
				throw new Error(`Could not fetch pools \n ${err}`)
			}
		} else {
			try {
				return await this.api.getPoolProfile(ids)
			} catch (err) {
				throw new Error(`Could not fetch pools \n ${err}`)
			}
		}
	}

	/**
	 * Get the confirmed account balance for a specific coin (defaults to BTC)
	 * @param {string} [coin='BTC'] - The coin you wish to get a balance for [BTC, LTC, ETH, DASH]
	 * @returns {Promise<(number|Object)>} - will return an object if success is false ex. {success: false}
	 */
	async getBalance(coin) {
		try {
			let response = await this.api.getAccountBalance()
			if (response.success) {
				if (coin) {
					return Number(response.data[coin.toUpperCase()].confirmed)
				} else {
					return Number(response.data['BTC'].confirmed)
				}
			} else {
				return {success: false}
			}
		} catch (err) {
			throw new Error(`Could not fetch account balance \n ${err}`)
		}
	}
	/**
	 * Get Back balances for all coins, confirmed and unconfirmed
	 * @returns {Promise<Object>}
	 */
	async getBalances() {
		try {
			let response = await this.api.getAccountBalance()
			if (response.success) {
				return response.data
			} else {
				return {success: false}
			}
		}
		 catch (err) {
			throw new Error(`Could not fetch account balance \n ${err}`)
		}
	}
	/**
	 * Get the total cost to rent multiple rigs
	 * @param {Array.<Object>} rigs_to_rent - See MRRProvider.getRigsToRent()
	 * @returns {number}
	 */
	getRentalCost(rigs_to_rent) {
		let cost = 0
		for (let rig of rigs_to_rent) {
			//ToDo: make the crypto-currency dynamic
			cost += rig.btc_price
		}
		return cost
	}
	/**
	 * Rent rigs based on hashrate and time
	 * @param {Object} options
	 * @param {number} options.hashrate - The hashrate in MH
	 * @param {number} options.duration - Duration of rent
	 * @param {Function} [options.confirm] - An async function for confirmation
	 * @param {string} [options.type='scrypt'] - Type of rig (Scrypt, x11, sha256, etc)
	 * @returns {Promise<*>}
	 */
	async rent(options) {
		//get balance
		let balance;
		try {
			balance = await this.getBalance()
		} catch (err) {
			throw new Error(err)
		}

		//get rigs
		let rigs_to_rent = [];
		try {
			rigs_to_rent = await this.getRigsToRent(options.hashrate, options.duration)
		} catch (err) {
			throw new Error(`Failed to fetch rigs to rent \n ${err}`)
		}

		let status = {
			status: 'normal'
		};

		//check cost of rigs against balance
		if (this.getRentalCost(rigs_to_rent) > balance) {
			status.status = 'warning'
			status.type = "LOW_BALANCE";
			status.rentalCost = this.getRentalCost(rigs_to_rent);
			status.currentBalance = balance

			let originalRigsToRentLength = rigs_to_rent.length;
			rigs_to_rent = selectBestCombination(rigs_to_rent, balance, rig => rig.btc_price)
			if (rigs_to_rent.length === 0) {
				status.message = 'Could not find any rigs to rent with available balance.'
			} else {
				status.message = `Can only rent ${rigs_to_rent.length}/${originalRigsToRentLength} rigs found with available balance.`
			}
		}

		//confirmation
		if (options.confirm) {
			try {
				let btc_total_price = 0
				let total_hashrate = 0

				for (let rig of rigs_to_rent){
					btc_total_price += rig.btc_price
					total_hashrate += rig.hashrate
				}

				let confirmed = await options.confirm({
					btc_total_price,
					total_hashrate,
					rigs: rigs_to_rent,
					status
				})

				if (!confirmed) {
					return {
						success: false,
						info: "Rental Cancelled",
						status
					}
				}
			} catch (err) {
				throw new Error(err)
			}
		}

		//rent rigs
		let rentalConfirmation = {};
		
		for (let rig of rigs_to_rent) {
			try {
				let rental = await this.api.createRental(rig.rental_info)
				rentalConfirmation[rig.rental_info.rig] = rental
			} catch (err) {
				rentalConfirmation[rig.rental_info.rig] = `Error renting rig: ${err}`
			}
		}

		let rented_rigs = []
		let spent_btc_amount = 0
		let total_rented_hashrate = 0

		for (let rig in rentalConfirmation){
			if (rentalConfirmation[rig].success){
				rented_rigs.push(rentalConfirmation[rig].data)
				spent_btc_amount += parseFloat(rentalConfirmation[rig].data.price.paid)
				total_rented_hashrate += rentalConfirmation[rig].data.hashrate.advertised.hash
			}
		}

		return {
			success: true,
			rented_rigs,
			btc_total_price: spent_btc_amount,
			total_hashrate: total_rented_hashrate,
			status
		}
	}
	/**
	 * Get back a "Serialized" state of the Provider
	 * @return {Object} Returns a JSON object that contains the current rental provider state
	 */
	serialize(){
		return {
			type: "MiningRigRentals",
			api_key: this.api_key,
			api_secret: this.api_secret,
			uid: this.uid
		}
	}
}

export default MRRProvider