// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title LodgingBooking
 * @notice A peer-to-peer lodging marketplace. Hosts list accommodation on their
 *         own terms and set the damage deposit they require. Guests book directly,
 *         paying rent + deposit into on-chain escrow. There is no platform operator
 *         and no percentage service fee: rent goes to the host, and the deposit is
 *         returned to the guest unless the host files a damage claim for it.
 *
 *         This directly addresses the problems described in the project README:
 *         - Peer to peer: no booking.com / expedia / airbnb intermediary.
 *         - Host-defined terms: each listing pins the host's terms (by hash/URI),
 *           and the guest must agree to those exact terms to book.
 *         - Room damage: the deposit is held in escrow and can be withheld by the
 *           host if the guest damages the room, instead of a flat 15% "service" fee.
 */
contract LodgingBooking {
    enum BookingStatus {
        None,
        Booked,
        CheckedOut, // guest confirmed check-out, deposit refundable after dispute window
        Completed, // host paid rent, guest refunded deposit
        DepositClaimed, // host withheld (part of) the deposit for damages
        Cancelled
    }

    struct Listing {
        uint256 id;
        address host;
        string title;
        string location;
        uint256 pricePerNight; // wei
        uint256 depositAmount; // wei held in escrow against damage
        string termsURI; // pointer to the host's full terms & conditions
        bytes32 termsHash; // hash of the exact terms the guest must accept
        bool active;
    }

    struct Booking {
        uint256 id;
        uint256 listingId;
        address guest;
        uint256 nights;
        uint256 rentPaid; // wei
        uint256 depositPaid; // wei
        bytes32 acceptedTermsHash;
        BookingStatus status;
    }

    uint256 public nextListingId = 1;
    uint256 public nextBookingId = 1;

    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Booking) public bookings;

    event ListingCreated(
        uint256 indexed listingId,
        address indexed host,
        uint256 pricePerNight,
        uint256 depositAmount,
        bytes32 termsHash
    );
    event ListingDeactivated(uint256 indexed listingId);
    event Booked(
        uint256 indexed bookingId,
        uint256 indexed listingId,
        address indexed guest,
        uint256 nights,
        uint256 rentPaid,
        uint256 depositPaid
    );
    event CheckedOut(uint256 indexed bookingId);
    event Completed(uint256 indexed bookingId, uint256 depositRefunded);
    event DepositClaimed(uint256 indexed bookingId, uint256 amountWithheld, uint256 depositRefunded, string reason);
    event Cancelled(uint256 indexed bookingId, uint256 refundToGuest);

    modifier onlyHost(uint256 listingId) {
        require(listings[listingId].host == msg.sender, "Not listing host");
        _;
    }

    /// @notice A host lists a property under their own terms.
    function createListing(
        string calldata title,
        string calldata location,
        uint256 pricePerNight,
        uint256 depositAmount,
        string calldata termsURI,
        bytes32 termsHash
    ) external returns (uint256 listingId) {
        require(bytes(title).length > 0, "Title required");
        require(pricePerNight > 0, "Price required");
        require(termsHash != bytes32(0), "Terms hash required");

        listingId = nextListingId++;
        listings[listingId] = Listing({
            id: listingId,
            host: msg.sender,
            title: title,
            location: location,
            pricePerNight: pricePerNight,
            depositAmount: depositAmount,
            termsURI: termsURI,
            termsHash: termsHash,
            active: true
        });

        emit ListingCreated(listingId, msg.sender, pricePerNight, depositAmount, termsHash);
    }

    /// @notice The host can take a listing off the market. Existing bookings are unaffected.
    function deactivateListing(uint256 listingId) external onlyHost(listingId) {
        listings[listingId].active = false;
        emit ListingDeactivated(listingId);
    }

    /// @notice A guest books a listing, agreeing to the host's exact terms.
    /// @dev The guest must pay rent (pricePerNight * nights) + the full deposit.
    ///      The guest passes the terms hash they agree to; it must match the listing.
    function book(uint256 listingId, uint256 nights, bytes32 acceptedTermsHash)
        external
        payable
        returns (uint256 bookingId)
    {
        Listing storage listing = listings[listingId];
        require(listing.host != address(0), "No such listing");
        require(listing.active, "Listing inactive");
        require(nights > 0, "Nights required");
        require(msg.sender != listing.host, "Host cannot book own listing");
        require(acceptedTermsHash == listing.termsHash, "Terms not accepted");

        uint256 rent = listing.pricePerNight * nights;
        uint256 total = rent + listing.depositAmount;
        require(msg.value == total, "Incorrect payment");

        bookingId = nextBookingId++;
        bookings[bookingId] = Booking({
            id: bookingId,
            listingId: listingId,
            guest: msg.sender,
            nights: nights,
            rentPaid: rent,
            depositPaid: listing.depositAmount,
            acceptedTermsHash: acceptedTermsHash,
            status: BookingStatus.Booked
        });

        emit Booked(bookingId, listingId, msg.sender, nights, rent, listing.depositAmount);
    }

    /// @notice The guest signals they have checked out and left the room in good order.
    function checkOut(uint256 bookingId) external {
        Booking storage b = bookings[bookingId];
        require(b.guest == msg.sender, "Not the guest");
        require(b.status == BookingStatus.Booked, "Not an active booking");
        b.status = BookingStatus.CheckedOut;
        emit CheckedOut(bookingId);
    }

    /// @notice The host settles a stay with no damage: rent is released to the host and
    ///         the full deposit is refunded to the guest.
    function completeStay(uint256 bookingId) external {
        Booking storage b = bookings[bookingId];
        Listing storage listing = listings[b.listingId];
        require(listing.host == msg.sender, "Not the host");
        require(
            b.status == BookingStatus.Booked || b.status == BookingStatus.CheckedOut,
            "Not settleable"
        );

        uint256 rent = b.rentPaid;
        uint256 deposit = b.depositPaid;
        b.status = BookingStatus.Completed;

        if (deposit > 0) {
            _pay(b.guest, deposit);
        }
        _pay(listing.host, rent);

        emit Completed(bookingId, deposit);
    }

    /// @notice The host reports guest-caused damage and withholds up to the deposit.
    ///         Rent is still released to the host; the remaining deposit (if any) is
    ///         refunded to the guest. No flat percentage fee is ever taken.
    function claimDamageDeposit(uint256 bookingId, uint256 amount, string calldata reason) external {
        Booking storage b = bookings[bookingId];
        Listing storage listing = listings[b.listingId];
        require(listing.host == msg.sender, "Not the host");
        require(
            b.status == BookingStatus.Booked || b.status == BookingStatus.CheckedOut,
            "Not settleable"
        );
        require(amount <= b.depositPaid, "Exceeds deposit");

        uint256 rent = b.rentPaid;
        uint256 refund = b.depositPaid - amount;
        b.status = BookingStatus.DepositClaimed;

        if (refund > 0) {
            _pay(b.guest, refund);
        }
        // Host receives rent plus the withheld damage amount.
        _pay(listing.host, rent + amount);

        emit DepositClaimed(bookingId, amount, refund, reason);
    }

    /// @notice The host cancels a booking before the stay and fully refunds the guest.
    function cancelBooking(uint256 bookingId) external {
        Booking storage b = bookings[bookingId];
        Listing storage listing = listings[b.listingId];
        require(listing.host == msg.sender, "Not the host");
        require(b.status == BookingStatus.Booked, "Not cancellable");

        uint256 refund = b.rentPaid + b.depositPaid;
        b.status = BookingStatus.Cancelled;
        _pay(b.guest, refund);

        emit Cancelled(bookingId, refund);
    }

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    function getBooking(uint256 bookingId) external view returns (Booking memory) {
        return bookings[bookingId];
    }

    function totalListings() external view returns (uint256) {
        return nextListingId - 1;
    }

    function totalBookings() external view returns (uint256) {
        return nextBookingId - 1;
    }

    function _pay(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Transfer failed");
    }
}
