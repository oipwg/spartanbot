import RentalProvider from './RentalProvider'
import MiningRigRentals from 'miningrigrentals-api-v2'

/**
 * A Rental Provider for MiningRigRentals
 */
class MRRProvider extends RentalProvider {
	/**
	 * Create a new MRR Provider
	 * @param  {Object} settings - Settings for the RentalProvider
	 * @param {String} settings.api_key - The API Key for the Rental Provider
	 * @param {String} settings.api_secret - The API Secret for the Rental Provider
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
			console.log(profile)
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
			profile = await this.api.getProfiles();
		} catch (err) {
			throw new Error(`error getting profile data: ${err}`)
		}
		if (profile.data) {
			return profile.data[0].id
		}
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

		let rigs_to_rent = [], hashpower = 0;
		for (let rig of available_rigs) {
			if ((hashpower + rig.hashrate.advertised.hash) <= hashrate) {
				let tmpObj = {};
				tmpObj['rig'] = Number(rig.id);
				tmpObj['length'] = duration
				tmpObj['profile'] = Number(profileID)
				// tmpObj['hashrate'] = rig.hashrate.advertised.hash
				hashpower += rig.hashrate.advertised.hash
				rigs_to_rent.push(tmpObj)
			}
		}
		return rigs_to_rent
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
		//get rigs
		let rigs_to_rent = [];
		try {
			rigs_to_rent = await this.getRigsToRent(options.hashrate, options.duration)
		} catch (err) {
			throw new Error(`Failed to fetch rigs to rent \n ${err}`)
		}

		//confirmation
		if (options.confirm) {
			try {
				let confirmed = await options.confirm(rigs_to_rent)
				if (!confirmed) {
					return {
						success: false,
						info: "Rental Cancelled"
					}
				}
			} catch (err) {
				throw new Error(err)
			}
		}

		//rent rigs
		let rentalConfirmation = {};
		let time = Date.now()
		for (let rig of rigs_to_rent) {
			try {
				let rental = await this.api.createRental(rig)
				let newTime = Date.now();
				console.log((newTime-time)/1000)
				time = newTime
				rentalConfirmation[rig.rig] = rental
				console.log(rental)
			} catch (err) {
				rentalConfirmation[rig.rig] = `Error renting rig: ${err}`
			}
		}
		// let rentalObject = {}
		// for (let rig of rigs_to_rent) {
		// 	rentalObject[`${rig.rig}`] = rig
		// }
		// console.log('rental object: ', rentalObject)
		// let rentalPromises = {}
		// for (let rig in rentalObject) {
		// 	rentalPromises[rig] = this.api.createRental(rentalObject[rig])
		// }
		//
		// let rentalConfirmation = {};
		// for (let rig in rentalPromises) {
		// 	try {
		// 		rentalConfirmation[rig] = await rentalPromises[rig]
		// 	} catch (err) {
		// 		rentalConfirmation[rig] = `Error attempting to rent ${rentalObject[rig]} \n ${err}`
		// 	}
		// }
		//return confirmation
		return rentalConfirmation
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