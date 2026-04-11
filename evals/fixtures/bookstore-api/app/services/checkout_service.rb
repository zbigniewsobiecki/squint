class CheckoutService
  attr_reader :user, :items, :order, :error

  def initialize(user:, items:)
    @user = user
    @items = items
    @order = nil
    @error = nil
  end

  def call
    return failure('No items provided') if items.blank?

    books = load_and_validate_books
    return self if error

    ActiveRecord::Base.transaction do
      @order = Order.create!(
        user: user,
        status: Order::STATUS_PENDING,
        total_cents: 0
      )

      total = 0
      books.each do |book, quantity|
        InventoryService.reserve(book, quantity)
        OrderItem.create!(
          order: @order,
          book: book,
          quantity: quantity,
          unit_price_cents: book.price_cents
        )
        total += book.price_cents * quantity
      end

      @order.update!(total_cents: total, status: Order::STATUS_CONFIRMED)
    end

    self
  rescue InsufficientStockError => e
    failure(e.message)
  rescue ActiveRecord::RecordInvalid => e
    failure(e.message)
  end

  def success?
    error.nil? && order.present?
  end

  private

  def load_and_validate_books
    result = {}
    items.each do |item|
      book = Book.find_by(id: item[:book_id])
      return failure("Book #{item[:book_id]} not found") unless book
      return failure("#{book.title} is out of stock") unless book.in_stock?

      result[book] = item[:quantity].to_i
    end
    result
  end

  def failure(message)
    @error = message
    self
  end
end
